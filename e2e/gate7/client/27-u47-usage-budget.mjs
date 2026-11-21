// ---- U47: usage, budget refusal, no learning-model fallback, switches, rate limits ----------------

async function u47() {
  const bd = await as("bd");
  const owner = await asOwner(TEAM_B);
  const t = await say(
    bd,
    [
      "No tools. Reply with the single word OK.",
      directive({ statement: `Gate7 ${N} usage fact` }),
    ].join("\n"),
    { title: "gate7 u47" },
  );
  out("turn", t.terminal);
  const p = await learn(bd, t.threadId);
  out("pass", passLine(p));
  const usage = await inTeam(TEAM_B, async (tx, sql) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM run_usage
      WHERE team_id = ${TEAM_B} AND user_id = ${USERS.bd.userId} AND kind = 'memory_learn'`);
    return r.rows[0]?.n ?? 0;
  });
  out("learn_usage_rows", usage);
  // A member budget used up: Learn says why and refuses (no pass, no call).
  const m2b = await as("m2", TEAM_B);
  const t2 = await say(m2b, "No tools. Reply with the single word OK. I prefer short answers.", {
    title: "gate7 u47 budget",
  });
  out("turn_budget", t2.terminal);
  const spent = await inTeam(TEAM_B, async (tx, sql) => {
    const r =
      await tx.execute(sql`SELECT coalesce(sum(tokens), 0)::text AS tokens FROM model_spend_daily
      WHERE team_id = ${TEAM_B} AND user_id = ${USERS.m2.userId} AND day = (now() AT TIME ZONE 'UTC')::date`);
    return Number(r.rows[0]?.tokens ?? 0);
  });
  const path = `/v1/team/budgets/members/${USERS.m2.userId}`;
  out("budget_set", (await bd.call("PUT", path, { daily_tokens: spent })).status);
  const st = await m2b.call("GET", `/v1/threads/${t2.threadId}/learn`);
  out("budget_blocker", st.json.blocker?.code ?? "-");
  out(
    "budget_refused",
    code(await m2b.call("POST", `/v1/threads/${t2.threadId}/learn`, { mode: "new" })),
  );
  out("budget_cleared", (await bd.call("DELETE", path)).status);
  // A learning model the workspace has not enabled: refused with its reason, never another model.
  const before = (await siteSettings(owner)).learning_model_alias;
  out(
    "alias_set",
    (
      await owner.call("PUT", "/v1/memory/settings?level=site", {
        settings: { learning_model_alias: config.unenabledAlias },
      })
    ).status,
  );
  const r = await bd.call("POST", `/v1/threads/${t.threadId}/learn`, { mode: "all" });
  out("unenabled_alias", `${code(r)}:${r.json.reason ?? "-"}`);
  out("unenabled_message", oneLine(r.json.message ?? "-").slice(0, 200));
  const override = await bd.call("PUT", "/v1/memory/settings?level=team", {
    learning_model_alias: config.unenabledAlias,
  });
  out("team_override_unenabled", code(override));
  out(
    "alias_restored",
    (
      await owner.call("PUT", "/v1/memory/settings?level=site", {
        settings: { learning_model_alias: before ?? config.alias },
      })
    ).status,
  );
  // The master switch: Notes and Memories off for the workspace's runs; nothing is deleted.
  const keep = await create(bd, {
    scope: "user",
    kind: "preference",
    statement: `Prefers gate7 ${N} switch survivors`,
  });
  out("keep_item", code(keep));
  const countB = async () => (await items(bd, "user")).usage?.count ?? -1;
  const n0 = await countB();
  out(
    "master_off",
    (await bd.call("PUT", "/v1/memory/settings?level=team", { memory_enabled: false })).status,
  );
  const eff = await bd.call("GET", "/v1/memory/settings?level=effective");
  out("effective_off", `notes=${eff.json.memory_enabled}:memories=${eff.json.memories_enabled}`);
  const off = await say(bd, "tools?", { title: "gate7 u47 off" });
  out(
    "off_tools",
    /remember|recall|show_memory_item/.test(off.text) ? "memory tools listed" : "no memory tools",
  );
  const offCtx = await contextOf(bd, off.threadId);
  out("off_context_user", offCtx.items.filter((i) => i.lane === "user").length);
  out(
    "master_on",
    (await bd.call("PUT", "/v1/memory/settings?level=team", { memory_enabled: true })).status,
  );
  const n1 = await countB();
  out("items_kept", `${n0 === n1}:${n1}`);
  if (keep.json.id)
    await bd.call("POST", `/v1/memory/semantic/items/user/${keep.json.id}/archive`, {});
  // Rate limit: 20 passes a person a day. The day's other 19 are fixture rows (failed, on this
  // thread), so the next start is the 21st; they are aged out again afterwards.
  const seeded = await inTeam(TEAM_B, async (tx, sql) => {
    const r = await tx.execute(sql`
      INSERT INTO memory_learning_passes
        (team_id, thread_id, user_id, branch_leaf_entry_id, from_entry_id, model_alias,
         prompt_version, status, error, started_at, finished_at)
      SELECT team_id, thread_id, user_id, branch_leaf_entry_id, from_entry_id, model_alias,
             prompt_version, 'failed', 'gate7 rate-limit fixture', now(), now()
        FROM memory_learning_passes, generate_series(1, 20)
       WHERE team_id = ${TEAM_B} AND id = ${p.passId}
      RETURNING id`);
    return r.rows.map((x) => x.id);
  });
  out("seeded", seeded.length);
  out(
    "rate_limited",
    code(await bd.call("POST", `/v1/threads/${t.threadId}/learn`, { mode: "all" })),
  );
  await inTeam(TEAM_B, (tx, sql) =>
    tx.execute(sql`UPDATE memory_learning_passes SET created_at = now() - interval '2 days'
      WHERE team_id = ${TEAM_B} AND error = 'gate7 rate-limit fixture'`),
  );
}
