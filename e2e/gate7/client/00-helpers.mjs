// Gate 7 (KOBE-675, v1.3 Semantic Memory) harness, client side: the API checks of U39-U54 the
// browser cannot make. e2e/gate7.sh runs this inside a Kaiju server pod (`node --input-type=module
// -e`) after the Gate 1-3 clients' helpers (everything above `const MODES` in e2e/gate1/client.mjs,
// gate2 and gate3: config, client(), db(), userClient(), ownerClient(), signedInAs(), follow(),
// startApprover(), code(), oneLine(), ...). Every step prints `key=value` lines for gate7.sh.
//
// The model is the fake provider (services/model-gateway/src/testing/fake-llm.ts): chat turns echo,
// `tool: <name> <json>` calls a tool, and a `memory_learn` extractor call is answered by
// fake-extractor.ts from markers in the transcript (`kaiju-learn {json}`, "I prefer …",
// "For the record: …"). The database is read for evidence only (pass rows, usage rows, audit
// rows), except where noted: a proposal's clock moved back (U42: 30 days cannot pass in CI) and
// rate-limit fixtures (U47: 20 passes in a day), both on the gate's own throwaway rows.

const N = config.nonce ?? "0";
const USERS = config.users ?? {};
const TEAM_A = config.teamA;
const TEAM_B = config.teamB;
const AKIA = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");

/** A gate user (fixtures key), signed in from an address of its own, in `team` (default theirs). */
const as = (key, team) => {
  const u = USERS[key];
  if (!u) throw new Error(`no gate7 user ${key}`);
  return signedInAs({ ...u, teamId: team ?? u.teamId });
};
const asOwner = async (team = TEAM_A) => {
  const c = await loginWithRetry(
    OWNER.email,
    OWNER.password,
    `198.51.103.${1 + Math.floor(Math.random() * 250)}`,
  );
  if (team) await c.useTeam(team);
  return c;
};
const json1 = (v) => oneLine(JSON.stringify(v ?? null)).slice(0, 600);
const has = (list, text) => (list ?? []).some((x) => String(x.statement ?? "").includes(text));
const directive = (fields) => `kaiju-learn ${JSON.stringify(fields)}`;

/** Runs `fn(tx, sql)` in `teamId`'s RLS context (evidence reads; the noted fixtures). */
async function inTeam(teamId, fn) {
  const database = await db();
  const m = await import("/app/node_modules/@kaiju/db/dist/index.js");
  try {
    return await m.withTeam(database.db, teamId, (tx) => fn(tx, m.sql));
  } finally {
    await database.close();
  }
}

/** One message (a new thread unless `threadId`), followed to its end. */
async function say(c, content, { threadId, title, projectId } = {}) {
  let t = threadId;
  if (!t) {
    const made = await c.call("POST", "/v1/threads", {
      title: title ?? `gate7 ${N}`,
      ...(projectId ? { project_id: projectId } : {}),
    });
    t = made.json.thread_id;
    if (!t)
      return {
        threadId: null,
        terminal: `thread:${code(made)}`,
        text: "",
        tools: [],
        memoryEvents: [],
      };
  }
  const sent = await c.call("POST", `/v1/threads/${t}/messages`, { content });
  const runId = sent.json.run_id;
  if (!runId)
    return {
      threadId: t,
      terminal: `message:${code(sent)}`,
      text: "",
      tools: [],
      memoryEvents: [],
    };
  const stop = startApprover(c, runId);
  let seen;
  try {
    seen = await follow(c, runId, 300_000);
  } finally {
    stop();
  }
  const of = (type) => seen.events.filter((e) => e.type === type).map((e) => e.data.payload ?? {});
  return {
    threadId: t,
    runId,
    terminal: seen.terminal?.type ?? "none",
    text: oneLine(
      of("text.delta")
        .map((p) => p.delta ?? "")
        .join(""),
    ),
    tools: of("tool.result"),
    memoryEvents: of("memory.updated"),
  };
}

async function passRow(teamId, passId) {
  return inTeam(teamId, async (tx, sql) => {
    const r = await tx.execute(sql`
      SELECT status, error, usage, model_alias, prompt_version FROM memory_learning_passes
       WHERE team_id = ${teamId} AND id = ${passId}`);
    return r.rows[0] ?? null;
  });
}

/** Starts a learning pass and waits for it to end; the pass row is the evidence. */
async function learn(c, threadId, mode = "new", extra = {}) {
  const r = await c.call("POST", `/v1/threads/${threadId}/learn`, { mode, ...extra });
  if (r.status !== 202)
    return { start: `${r.status}:${r.json.code ?? "-"}`, refusal: r.json, candidates: [] };
  const passId = r.json.pass_id;
  for (let i = 0; i < 90; i += 1) {
    const st = await c.call("GET", `/v1/threads/${threadId}/learn`);
    if (st.status === 200 && st.json.running === null) break;
    await sleep(2_000);
  }
  const row = await passRow(c.team, passId);
  const listed = await c.call("GET", `/v1/memory/review?thread_id=${threadId}`);
  return {
    start: "202:-",
    passId,
    runId: r.json.run_id,
    input: r.json.input,
    status: row?.status ?? "-",
    error: row?.error ?? "-",
    counts: row?.usage?.counts ?? {},
    row,
    candidates: listed.json.candidates ?? [],
    review: listed.json,
  };
}
const passLine = (p) =>
  `${p.status}:replied=${p.counts.replied ?? "-"}:stored=${p.counts.stored ?? "-"}:dropped=${p.counts.dropped ?? "-"}`;

async function items(c, scope, q, status = "active") {
  const r = await c.call(
    "GET",
    `/v1/memory/semantic/items?scope=${scope}&status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}&limit=100`,
  );
  return { status: r.status, items: r.json.items ?? [], usage: r.json.usage };
}
const create = (c, body) => c.call("POST", "/v1/memory/semantic/items", body);
/**
 * What the thread's latest run was given. The route answers the latest run *with records*, with
 * `latest: false` when a newer run was given no memories: that newer run then got none.
 */
const contextOf = async (c, threadId) => {
  const r = await c.call("GET", `/v1/threads/${threadId}/context/memories`);
  const latest = r.json.latest !== false;
  return { status: r.status, items: latest ? (r.json.items ?? []) : [], runId: r.json.run_id };
};
async function notices(c) {
  const r = await c.call("GET", "/v1/notifications?limit=100");
  return (r.json.notifications ?? r.json.items ?? []).map((n) => n.kind ?? n.type ?? "?");
}
async function auditActions(teamId, sinceIso) {
  return inTeam(teamId, async (tx, sql) => {
    const r = await tx.execute(sql`
      SELECT action, actor_id, target::text AS target FROM audit_log
       WHERE team_id = ${teamId} AND at >= ${sinceIso}::timestamptz ORDER BY seq`);
    return r.rows;
  });
}
async function siteSettings(owner) {
  return (await owner.call("GET", "/v1/memory/settings?level=site")).json.settings ?? {};
}
