// ---- U48: memories in context with versions; changes apply from the next run --------------------

async function u48() {
  const ad = await as("ad");
  const text = `Gate7 ${N} ferry timetable lives in the harbour wiki`;
  const made = await create(ad, { scope: "user", kind: "fact", statement: text });
  out("item", code(made));
  const id = made.json.id;
  const t1 = await say(
    ad,
    `No tools. Reply with the single word OK. Where is the ferry timetable ${N}?`,
    { title: "gate7 u48" },
  );
  out("turn1", t1.terminal);
  const c1 = await contextOf(ad, t1.threadId);
  const g1 = c1.items.find((i) => i.id === id);
  out("run1", `${c1.status}:${g1 ? `${g1.lane}:v${g1.version}` : "absent"}`);
  const edit = await ad.call("PATCH", `/v1/memory/semantic/items/user/${id}`, {
    expected_version: 1,
    statement: `${text} (page two)`,
  });
  out("edit", code(edit));
  const t2 = await say(
    ad,
    `No tools. Reply with the single word OK. The ferry timetable ${N} again?`,
    { threadId: t1.threadId },
  );
  out("turn2", t2.terminal);
  const c2 = await contextOf(ad, t1.threadId);
  const g2 = c2.items.find((i) => i.id === id);
  out(
    "run2",
    `${g2 ? `v${g2.version}:${g2.statement.endsWith("(page two)")}` : "absent"}:run_changed=${c1.runId !== c2.runId}`,
  );
  // Picks are made per message (Q6) from the message, the title and the last two user messages:
  // a message that matches none of it (a new thread, a neutral title) leaves it out.
  const t3 = await say(ad, "No tools. Reply with the single word OK. Something else entirely.", {
    title: "unrelated",
  });
  out("turn3", t3.terminal);
  const c3 = await contextOf(ad, t3.threadId);
  out(
    "run3_has_it",
    c3.items.some((i) => i.id === id),
  );
  // Owner only: a reader of the shared thread gets no memories.
  await ad.call("POST", `/v1/threads/${t1.threadId}/share`, { visibility: "team" });
  const m2 = await as("m2");
  out("reader_context", code(await m2.call("GET", `/v1/threads/${t1.threadId}/context/memories`)));
  await ad.call("POST", `/v1/threads/${t1.threadId}/share`, { visibility: "private" });
  await ad.call("POST", `/v1/memory/semantic/items/user/${id}/archive`, {});
}
