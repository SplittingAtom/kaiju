// ---- U39: Learn for the author; ≤10 candidates with verified quotes; nothing saved without a click

async function u39() {
  const m2 = await as("m2");
  // Twelve unrelated facts (no near-duplicates of each other): the pass keeps the best ten.
  const facts = [
    "the blue printer sits on floor two",
    "standups start at nine fifteen",
    "the staging cluster is named Juniper",
    "invoices are paid on the fifth",
    "the wiki moved to the intranet",
    "release notes are written by product",
    "the VPN needs a hardware token",
    "desk bookings open on Mondays",
    "the design review happens fortnightly",
    "parking passes come from facilities",
    "the support rota changes weekly",
    "laptops are refreshed every three years",
  ].map((f) => `Gate7 ${N} fact: ${f}`);
  const message = [
    "No tools. Reply with the single word OK.",
    ...facts.map((s) => directive({ statement: s })),
  ].join("\n");
  const t = await say(m2, message, { title: "gate7 u39" });
  out("turn", t.terminal);
  const p = await learn(m2, t.threadId);
  out("pass", passLine(p));
  out("candidates", p.candidates.length);
  const verified = p.candidates.filter((c) =>
    (c.evidence ?? []).every((e) => message.includes(e.quote)),
  ).length;
  out("quotes_verified", `${verified}/${p.candidates.length}`);
  out("saved_before_click", (await items(m2, "user", `Gate7 ${N} fact`)).items.length);
  const first = p.candidates[0];
  if (first) {
    const s = await m2.call("POST", `/v1/memory/review/candidates/${first.id}/save`, {});
    out("save_click", `${s.status}:${s.json.item?.scope ?? s.json.code ?? "-"}`);
  }
  out("saved_after_click", (await items(m2, "user", `Gate7 ${N} fact`)).items.length);
  // A Team admin reading the shared thread may not teach Kaiju from it.
  const share = await m2.call("POST", `/v1/threads/${t.threadId}/share`, { visibility: "team" });
  out("share", share.status);
  const ad = await as("ad");
  out("reader_state", code(await ad.call("GET", `/v1/threads/${t.threadId}/learn`)));
  out(
    "reader_start",
    code(await ad.call("POST", `/v1/threads/${t.threadId}/learn`, { mode: "new" })),
  );
  await m2.call("POST", `/v1/threads/${t.threadId}/share`, { visibility: "private" });
}
