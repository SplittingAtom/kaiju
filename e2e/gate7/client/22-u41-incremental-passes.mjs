// ---- U41: incremental passes, dismissals, update with a diff, fork rules -------------------------

async function u41() {
  const c = await as("st");
  const alpha = `Gate7 ${N} alpha decision stands`;
  const beta = `Gate7 ${N} beta decision stands`;
  const gamma = `Gate7 ${N} gamma decision stands`;
  const revised = `Gate7 ${N} alpha decision was revised`;
  const delta = `Gate7 ${N} delta decision stands`;
  const ok = "No tools. Reply with the single word OK.";
  const t1 = await say(
    c,
    [ok, directive({ statement: alpha }), directive({ statement: beta })].join("\n"),
    {
      title: "gate7 u41",
    },
  );
  const T = t1.threadId;
  out("turn1", t1.terminal);
  const p1 = await learn(c, T);
  out("pass1", passLine(p1));
  out("pass1_entries", p1.input?.entries ?? "-");
  const cAlpha = p1.candidates.find((x) => x.statement === alpha);
  const cBeta = p1.candidates.find((x) => x.statement === beta);
  out(
    "save_alpha",
    (await c.call("POST", `/v1/memory/review/candidates/${cAlpha?.id}/save`, {})).status,
  );
  out(
    "dismiss_beta",
    (await c.call("POST", `/v1/memory/review/candidates/${cBeta?.id}/dismiss`)).status,
  );
  const t2 = await say(
    c,
    [ok, directive({ statement: gamma }), directive({ statement: revised, target: alpha })].join(
      "\n",
    ),
    { threadId: T },
  );
  out("turn2", t2.terminal);
  const p2 = await learn(c, T);
  out("pass2", passLine(p2));
  out("pass2_entries", p2.input?.entries ?? "-");
  out("pass2_has_gamma", has(p2.candidates, gamma));
  out("pass2_has_beta", has(p2.candidates, beta));
  const upd = p2.candidates.find((x) => x.statement === revised);
  out(
    "update_diff",
    `${upd?.operation ?? "-"}:target=${upd?.target?.statement === alpha}:${upd?.target?.version ?? "-"}`,
  );
  // Nothing new since pass 2: Learn says so; Rescan reads everything again but a dismissal stays.
  out("nothing_new", code(await c.call("POST", `/v1/threads/${T}/learn`, { mode: "new" })));
  const p3 = await learn(c, T, "all");
  out("pass3", passLine(p3));
  out("pass3_entries", p3.input?.entries ?? "-");
  out("pass3_has_beta", has(p3.candidates, beta));
  // Another branch than the one in view is refused.
  out(
    "other_branch",
    code(
      await c.call("POST", `/v1/threads/${T}/learn`, {
        mode: "all",
        viewed_leaf_entry_id: "00000000-0000-4000-8000-000000000000",
      }),
    ),
  );
  // A fork learns from its own messages only, even on Rescan.
  const fork = await c.call("POST", `/v1/threads/${T}/fork`, {});
  out("fork", code(fork));
  const F = fork.json.thread_id;
  const tf = await say(c, [ok, directive({ statement: delta })].join("\n"), { threadId: F });
  out("turn_fork", tf.terminal);
  const pf = await learn(c, F, "all");
  out("fork_pass", passLine(pf));
  const forkStatements = pf.candidates.map((x) => x.statement);
  out(
    "fork_candidates",
    [delta, alpha, beta, gamma, revised]
      .map((s) => `${s.split(" ")[2]}=${forkStatements.includes(s)}`)
      .join(","),
  );
}
