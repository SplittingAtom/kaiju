// ---- U42: Workspace proposals ----------------------------------------------------------------------

async function u42() {
  const m2 = await as("m2");
  const fact = `Gate7 ${N} the build server is called Kestrel`;
  const second = `Gate7 ${N} the backup window starts at midnight`;
  const t = await say(
    m2,
    [
      "No tools. Reply with the single word OK.",
      directive({ statement: fact, scope: "team" }),
      directive({ statement: second, scope: "team" }),
    ].join("\n"),
    { title: "gate7 u42" },
  );
  out("turn", t.terminal);
  const p = await learn(m2, t.threadId);
  out("pass", passLine(p));
  const c1 = p.candidates.find((x) => x.statement === fact);
  const c2 = p.candidates.find((x) => x.statement === second);
  out(
    "member_save_team",
    code(await m2.call("POST", `/v1/memory/review/candidates/${c1?.id}/save`, { scope: "team" })),
  );
  const pr1 = await m2.call("POST", `/v1/memory/review/candidates/${c1?.id}/propose`, {
    rationale: "Everyone builds there.",
  });
  out("propose", code(pr1));
  const pr2 = await m2.call("POST", `/v1/memory/review/candidates/${c2?.id}/propose`, {});
  out("propose2", code(pr2));
  const days = (Date.parse(pr1.json.expires_at ?? "") - Date.now()) / 86_400_000;
  out("expires_days", Number.isFinite(days) ? Math.round(days) : "-");
  const ad = await as("ad");
  const queue = await ad.call("GET", "/v1/memory/proposals");
  const listed = JSON.stringify(queue.json);
  out("curator_queue", `${queue.status}:${listed.includes(fact)}`);
  out("curator_notified", (await notices(ad)).includes("memory.proposal.received"));
  const approve = await ad.call("POST", `/v1/memory/proposals/${pr1.json.proposal_id}/approve`, {});
  out("approve", code(approve));
  out("team_item", (await items(ad, "team", fact)).items.length);
  out("proposer_notified", (await notices(m2)).includes("memory.proposal.accepted"));
  // Every member's next run: the steward (another member) asks about it.
  const st = await as("st");
  const ts = await say(
    st,
    `No tools. Reply with the single word OK. Which build server is Kestrel ${N}?`,
    {
      title: "gate7 u42 st",
    },
  );
  out("member_turn", ts.terminal);
  out(
    "member_run_has_it",
    (await contextOf(st, ts.threadId)).items.some((i) => i.statement === fact && i.lane === "team"),
  );
  // 30 days cannot pass in CI: the second proposal's clock is moved back (a fixture on its row),
  // then it reads as lapsed and its proposer sends it again with a new clock.
  await inTeam(TEAM_A, (tx, sql) =>
    tx.execute(sql`UPDATE memory_proposals SET expires_at = now() - interval '1 day'
      WHERE team_id = ${TEAM_A} AND id = ${pr2.json.proposal_id}`),
  );
  const mine = await m2.call("GET", "/v1/memory/proposals/mine");
  const old = JSON.stringify(mine.json).includes(`"may_repropose":true`);
  out("lapsed_may_repropose", old);
  const again = await m2.call("POST", `/v1/memory/proposals/${pr2.json.proposal_id}/repropose`);
  out("repropose", code(again));
  const days2 = (Date.parse(again.json.expires_at ?? "") - Date.now()) / 86_400_000;
  out("repropose_days", Number.isFinite(days2) ? Math.round(days2) : "-");
}
