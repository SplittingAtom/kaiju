// ---- U40: saves with Undo in this team only; portable after confirmation; no portable fact ------

async function u40() {
  const m2 = await as("m2");
  const pref = `Prefers gate7 ${N} answers written as haiku`;
  const fact = `Gate7 ${N} my desk is by the north window`;
  const t = await say(
    m2,
    [
      "No tools. Reply with the single word OK.",
      directive({ statement: pref, kind: "preference" }),
      directive({ statement: fact, kind: "fact" }),
    ].join("\n"),
    { title: "gate7 u40" },
  );
  out("turn", t.terminal);
  const p = await learn(m2, t.threadId);
  out("pass", passLine(p));
  const cPref = p.candidates.find((c) => c.statement === pref);
  const cFact = p.candidates.find((c) => c.statement === fact);
  out("allowed_pref", (cPref?.allowed_scopes ?? []).join(","));
  out("allowed_fact", (cFact?.allowed_scopes ?? []).join(","));
  const saveFact = await m2.call("POST", `/v1/memory/review/candidates/${cFact?.id}/save`, {});
  out("save_fact", `${saveFact.status}:${saveFact.json.item?.scope ?? saveFact.json.code ?? "-"}`);
  out("fact_in_a", (await items(m2, "user", fact)).items.length);
  const m2b = await as("m2", TEAM_B);
  out("fact_in_b", (await items(m2b, "user", fact)).items.length);
  const undo = await m2.call("POST", "/v1/memory/review/undo", { candidate_ids: [cFact?.id] });
  out("undo", undo.status);
  out("fact_after_undo", (await items(m2, "user", fact)).items.length);
  // Portable: refused without the confirmation, then saved; a fact can never be portable.
  const noConfirm = await m2.call("POST", `/v1/memory/review/candidates/${cPref?.id}/save`, {
    scope: "portable",
  });
  out("portable_unconfirmed", code(noConfirm));
  const factPortable = await create(m2, {
    scope: "portable",
    kind: "fact",
    statement: `Gate7 ${N} portable fact`,
    confirm_portable: true,
  });
  out("portable_fact", code(factPortable));
  const yes = await m2.call("POST", `/v1/memory/review/candidates/${cPref?.id}/save`, {
    scope: "portable",
    confirm_portable: true,
  });
  out("portable_saved", `${yes.status}:${yes.json.item?.scope ?? yes.json.code ?? "-"}`);
  out("portable_in_b", (await items(m2b, "portable", pref)).items.length);
  const tb = await say(m2b, "No tools. Reply with the single word OK. How should answers look?", {
    title: "gate7 u40 b",
  });
  out("turn_b", tb.terminal);
  const ctx = await contextOf(m2b, tb.threadId);
  out(
    "portable_in_b_run",
    ctx.items.some((i) => i.statement === pref && i.lane === "portable"),
  );
  const id = yes.json.item?.id;
  if (id) await m2.call("POST", `/v1/memory/semantic/items/portable/${id}/archive`, {});
}
