import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, withTeam } from "@kaiju/db";
import {
  CAPABILITY_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY,
  runMemoryContextSchema,
  type PolicyEngine,
  type RunMemoryContext,
} from "@kaiju/protocol";
import { memoryResultFrameSchema } from "@kaiju/protocol/sandbox-wire";
import type { Logger } from "pino";
import { readMemory, showMemory } from "./agent.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";
import { MemoryObjects } from "../testing/memory-objects.js";

/**
 * KOBE-399 (SMB11, SM26): `recall({ query })` answers the runner's matching saved memories
 * (semantic items of the enabled scopes, best first) beside the Notes files; path reads and scoped
 * queries stay Notes only; nothing for an agent version with `notes_only`. `show_memory_item`
 * answers only for an id the run was given or recalled, and writes nothing. Archiving the item
 * (what the "Open in Memory" chip leads to) keeps it out of the next run.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

const engine: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "read" as const,
      reasons: [{ code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" }],
    }),
};

let runner: Person;
let other: Person;
let team: string;
let teamB: string;
const WORD = `quokka${randomBytes(3).toString("hex")}`;
const item: Record<string, string> = {};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs: { objects: new MemoryObjects(), prefix: "kaiju/" },
    agents: { publishRate: { windowMs: 60_000, max: 10_000 } },
    sandboxWire: {
      engine,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
  runner = await fx.person(`rc${randomBytes(2).toString("hex")}`);
  other = await fx.person(`ro${randomBytes(2).toString("hex")}`);
  team = await fx.team(`rci-${randomBytes(3).toString("hex")}`, runner, [other]);
  teamB = await fx.team(`rcb-${randomBytes(3).toString("hex")}`, runner, [other]);
  await fx.activate(runner, team);
  const s = (label: string) => `${label} ${WORD} statement`;
  item.team = await seed({ scope: "team", team, statement: s("Workspace fact") });
  item.mine = await seed({ scope: "user", team, owner: runner.id, statement: s("My fact") });
  item.theirs = await seed({ scope: "user", team, owner: other.id, statement: s("Their fact") });
  item.otherTeam = await seed({ scope: "team", team: teamB, statement: s("Other workspace") });
  item.portable = await seed({ scope: "portable", owner: runner.id, statement: s("My portable") });
  item.site = await seed({ scope: "site", statement: s("Site fact") });
  item.unrelated = await seed({ scope: "team", team, statement: "Lunch is at noon on Fridays" });
  item.policy = await seed({ scope: "site", policy: true, statement: "Never share customer data" });
});

afterAll(async () => {
  for (const sb of sandboxes) sb.close();
  await listener.close();
  await fx.teardown();
});

async function seed(o: {
  scope: "user" | "team" | "portable" | "site";
  statement: string;
  team?: string;
  owner?: string;
  policy?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const actor = o.owner ?? runner.id;
  const kind = o.scope === "portable" ? "preference" : "fact";
  await fx.admin.query("BEGIN");
  try {
    if (o.scope === "user" || o.scope === "team") {
      await fx.admin.query(
        `INSERT INTO semantic_memory_items (team_id, id, scope, owner_user_id, kind)
         VALUES ($1, $2, $3, $4, $5)`,
        [o.team, id, o.scope, o.scope === "user" ? o.owner : null, kind],
      );
      await fx.admin.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, $2, 1, $3, $4, 'user')`,
        [o.team, id, o.statement, actor],
      );
    } else if (o.scope === "portable") {
      await fx.admin.query(
        `INSERT INTO portable_memory_items (id, owner_user_id, kind) VALUES ($1, $2, $3)`,
        [id, o.owner, kind],
      );
      await fx.admin.query(
        `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, o.owner],
      );
    } else {
      await fx.admin.query(`INSERT INTO site_memory_items (id, kind, policy) VALUES ($1, $2, $3)`, [
        id,
        kind,
        o.policy ?? false,
      ]);
      await fx.admin.query(
        `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, actor],
      );
    }
    await fx.admin.query("COMMIT");
  } catch (err) {
    await fx.admin.query("ROLLBACK");
    throw err;
  }
  return id;
}

interface Run {
  readonly threadId: string;
  readonly runId: string;
}

async function newRun(thread: { agentId?: string; agentVersion?: number } = {}): Promise<Run> {
  return withTeam(fx.db, team, async (tx) => {
    const t = await tx.execute<{ id: string }>(sql`
      INSERT INTO threads (team_id, owner_user_id, status, agent_scope, agent_id, agent_version)
      VALUES (${team}, ${runner.id}, 'running', ${thread.agentId ? "team" : null},
              ${thread.agentId ?? null}, ${thread.agentVersion ?? null})
      RETURNING id`);
    const threadId = must(t.rows[0], "thread").id;
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO runs (team_id, thread_id, trigger, status, started_at, agent_version)
      VALUES (${team}, ${threadId}, 'user', 'running', now(), ${thread.agentVersion ?? null})
      RETURNING id`);
    return { threadId, runId: must(r.rows[0], "run").id };
  });
}

async function records(runId: string): Promise<string[]> {
  const res = await fx.admin.query<{ item_id: string }>(
    `SELECT item_id FROM run_memory_items WHERE team_id = $1 AND run_id = $2
     UNION ALL SELECT item_id FROM run_portable_memory_items WHERE team_id = $1 AND run_id = $2
     UNION ALL SELECT item_id FROM run_site_memory_items WHERE team_id = $1 AND run_id = $2`,
    [team, runId],
  );
  return res.rows.map((r) => r.item_id);
}

interface Session {
  readonly sb: FakeSandbox;
  readonly run: Run;
  readonly memory: RunMemoryContext | undefined;
}

/** A sandbox of the runner with memory and semantic memory, the run started and its records in. */
async function session(run: Run, message = "hello there"): Promise<Session> {
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    listener.url,
    auth.issue({ sandboxId, teamId: team, userId: runner.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], undefined, [CAPABILITY_MEMORY, CAPABILITY_SEMANTIC_MEMORY]);
  await sb.ready();
  const started = fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: runner.id },
      { runId: run.runId, threadId: run.threadId, message },
    );
  const start = (await sb.until(() => sb.frames("run.start")[0])) as { memory?: unknown };
  expect(await started).toEqual({ ok: true });
  const memory =
    start.memory === undefined ? undefined : runMemoryContextSchema.parse(start.memory);
  const given = memory?.semantic?.items.length ?? 0;
  await vi.waitFor(async () => expect((await records(run.runId)).length).toBe(given), {
    timeout: 5_000,
  });
  return { sb, run, memory };
}

let seq = 0;

/** A tool call as the sandbox makes it: the policy check, then the frame. */
async function call(s: Session, tool: string, type: string, input: Record<string, unknown>) {
  const callId = `t${seq++}`;
  const check = `c${seq++}`;
  s.sb.send({
    v: 1,
    type: "policy.check",
    request_id: check,
    run_id: s.run.runId,
    thread_id: s.run.threadId,
    tool_call_id: callId,
    tool,
    input,
  });
  const verdict = (await s.sb.until(
    () => s.sb.frames("policy.result").find((r) => r.request_id === check),
    3000,
  )) as { decision: string };
  expect(verdict.decision).toBe("allow");
  const request_id = `m${seq++}`;
  s.sb.send({
    v: 1,
    type,
    request_id,
    run_id: s.run.runId,
    thread_id: s.run.threadId,
    tool_call_id: callId,
    input,
  });
  const res = await s.sb.until(
    () => s.sb.frames("memory.result").find((r) => r.request_id === request_id),
    5000,
  );
  return memoryResultFrameSchema.parse(res) as Record<string, any>;
}

const recall = (s: Session, input: Record<string, unknown>) =>
  call(s, "recall", "memory.read", input);
const show = (s: Session, id: string | undefined) =>
  call(s, "show_memory_item", "memory.show", { id: must(id, "item id") });
const idsOf = (items: { id: string }[] | undefined) => (items ?? []).map((i) => i.id);

/** Everything a show could change: item rows, versions, run records and audit rows. */
async function snapshot(): Promise<string> {
  const res = await fx.admin.query<{ t: string }>(
    `SELECT concat_ws('|',
       (SELECT string_agg(id || status || current_version || updated_at, ',' ORDER BY id) FROM semantic_memory_items),
       (SELECT count(*) FROM semantic_memory_item_versions),
       (SELECT string_agg(id || status || current_version || updated_at, ',' ORDER BY id) FROM portable_memory_items),
       (SELECT string_agg(id || status || current_version || updated_at, ',' ORDER BY id) FROM site_memory_items),
       (SELECT count(*) FROM run_memory_items), (SELECT count(*) FROM run_portable_memory_items),
       (SELECT count(*) FROM run_site_memory_items), (SELECT count(*) FROM audit_log)) AS t`,
  );
  return must(res.rows[0], "snapshot").t;
}

describe("recall over saved memories (ac-1)", () => {
  it("answers the runner's matching items of every enabled scope, never others'", async () => {
    const s = await session(await newRun());
    const res = await recall(s, { query: WORD });
    expect(res).toMatchObject({ ok: true, op: "read" });
    const ids = idsOf(res.items);
    expect(ids).toEqual(expect.arrayContaining([item.team, item.mine, item.portable, item.site]));
    for (const k of ["theirs", "otherTeam", "unrelated"]) expect(ids).not.toContain(item[k]);
    const portable = res.items.find((i: { id: string }) => i.id === item.portable);
    expect(portable).toMatchObject({ scope: "portable", kind: "preference", version: 1 });
  });

  it("keeps path reads, listings and scoped queries Notes only", async () => {
    const s = await session(await newRun());
    expect((await recall(s, {})).items).toBeUndefined();
    expect((await recall(s, { scope: "user", query: WORD })).items).toBeUndefined();
    const path = await recall(s, { scope: "user", path: "MEMORY.md" });
    expect(path.items).toBeUndefined();
  });

  it("follows the Workspace switches", async () => {
    await fx.admin.query(
      `UPDATE teams SET settings = jsonb_set(settings, '{memory}', $2::jsonb) WHERE id = $1`,
      [team, JSON.stringify({ workspace_memories_enabled: false })],
    );
    try {
      const s = await session(await newRun());
      const ids = idsOf((await recall(s, { query: WORD })).items);
      expect(ids).not.toContain(item.team);
      expect(ids).toContain(item.mine);
    } finally {
      await fx.admin.query(
        `UPDATE teams SET settings = jsonb_set(settings, '{memory}', '{}'::jsonb) WHERE id = $1`,
        [team],
      );
    }
  });

  it("answers no items for an agent version whose memory setting is notes_only", async () => {
    const agentId = await createAgent("Noter");
    await publish(agentId);
    const version = await setMemory(agentId, "notes_only");
    const s = await session(await newRun({ agentId, agentVersion: version }));
    const res = await recall(s, { query: WORD });
    expect(res).toMatchObject({ ok: true, op: "read" });
    expect(res.items).toBeUndefined();
  });
});

describe("show_memory_item (ac-2)", () => {
  it("shows an item the run was given, and one an earlier recall answered", async () => {
    const s = await session(await newRun(), `What about ${WORD}?`);
    const given = idsOf(s.memory?.semantic?.items);
    expect(given).toContain(item.team);
    expect(await show(s, item.team)).toMatchObject({
      ok: true,
      op: "show",
      item: { id: item.team, scope: "team", status: "active", statement: expect.any(String) },
    });

    const fresh = await session(await newRun());
    expect(idsOf(fresh.memory?.semantic?.items)).not.toContain(item.site);
    expect((await show(fresh, item.site)).ok).toBe(false);
    expect(idsOf((await recall(fresh, { query: WORD })).items)).toContain(item.site);
    expect(await show(fresh, item.site)).toMatchObject({ ok: true, item: { scope: "site" } });
  });

  it("refuses unknown ids, others' items and items never given, and changes nothing", async () => {
    const s = await session(await newRun());
    await recall(s, { query: WORD });
    const before = await snapshot();
    for (const id of [randomUUID(), item.theirs, item.otherTeam, item.unrelated]) {
      const res = await show(s, id);
      expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect((await show(s, item.mine)).ok).toBe(true);
    expect(await snapshot()).toBe(before);
  });
});

const quiet = { error: () => undefined } as unknown as Logger;
const caller = (run: Run) => ({
  teamId: team,
  userId: runner.id,
  runId: run.runId,
  threadId: run.threadId,
  refused: () => undefined,
});
const setWorkspace = (memory: Record<string, boolean>) =>
  fx.admin.query(
    `UPDATE teams SET settings = jsonb_set(settings, '{memory}', $2::jsonb) WHERE id = $1`,
    [team, JSON.stringify(memory)],
  );

describe("review fixes", () => {
  it("answers saved memories from recall({ query }) without blob storage, Notes refused", async () => {
    const run = await newRun();
    const deps = { db: fx.db, blobs: undefined, log: quiet };
    const res = await readMemory(deps, { ...caller(run), input: { query: WORD } });
    expect(res).toMatchObject({ ok: true, op: "read", files: [], truncated: false });
    expect(idsOf((res as { items?: { id: string }[] }).items)).toContain(item.mine);
    const notes = await readMemory(deps, {
      ...caller(run),
      input: { scope: "user", path: "MEMORY.md" },
    });
    expect(notes).toMatchObject({ ok: false, error: { code: "storage_failed" } });
  });

  it("shows only a given Policy item under notes_only, and re-checks the scope switch", async () => {
    const agentId = await createAgent("Shower");
    await publish(agentId);
    const version = await setMemory(agentId, "notes_only");
    const notes = await session(await newRun({ agentId, agentVersion: version }));
    expect(idsOf(notes.memory?.semantic?.items)).toEqual([item.policy]);
    expect(await show(notes, item.policy)).toMatchObject({ ok: true, item: { policy: true } });
    // A recalled id would not be enough without semantic memory.
    const deps = { db: fx.db, log: quiet };
    const recalled = await showMemory(deps, {
      ...caller(notes.run),
      input: { id: must(item.team, "team item") },
      recalled: () => "team",
    });
    expect(recalled).toMatchObject({ ok: false, error: { code: "not_found" } });

    const s = await session(await newRun(), `What about ${WORD}?`);
    expect(idsOf(s.memory?.semantic?.items)).toContain(item.team);
    await setWorkspace({ workspace_memories_enabled: false });
    try {
      expect(await show(s, item.team)).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect((await show(s, item.mine)).ok).toBe(true);
    } finally {
      await setWorkspace({});
    }
  });
});

describe("Forget X through the chip (ac-3)", () => {
  it("archiving the shown item keeps it out of the next run and its recall", async () => {
    const forget = await seed({
      scope: "user",
      team,
      owner: runner.id,
      statement: `Forget ${WORD} soon`,
    });
    const s = await session(await newRun(), `Forget ${WORD} soon`);
    expect(idsOf(s.memory?.semantic?.items)).toContain(forget);
    expect((await show(s, forget)).item).toMatchObject({ id: forget, status: "active" });
    // The chip links to the item in My memory, where Archive is one click (the same API).
    const res = await runner.browser.post(`/v1/memory/semantic/items/user/${forget}/archive`, {
      expected_version: 1,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // Same run: still shown (it was given), now archived.
    expect((await show(s, forget)).item).toMatchObject({ status: "archived" });
    const next = await session(await newRun(), `Forget ${WORD} soon`);
    expect(idsOf(next.memory?.semantic?.items)).not.toContain(forget);
    expect(idsOf((await recall(next, { query: WORD })).items)).not.toContain(forget);
    expect((await show(next, forget)).ok).toBe(false);
  });
});

async function createAgent(name: string): Promise<string> {
  const res = await runner.browser.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `${name} ${randomBytes(2).toString("hex")}` },
    prompt: `You are ${name}.`,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { agent: { id: string } }).agent.id;
}

async function publish(id: string) {
  const res = await runner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

async function setMemory(id: string, memory: string): Promise<number> {
  const res = await runner.browser.post(`/v1/agents/${id}/memory`, { memory });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { version: { version: number } }).version.version;
}
