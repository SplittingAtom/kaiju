// ---- U54: forget X ---------------------------------------------------------------------------------

async function u54() {
  const m2 = await as("m2");
  const text = `Gate7 ${N} lunch is at noon on Fridays`;
  const made = await create(m2, { scope: "user", kind: "fact", statement: text, pinned: true });
  out("item", code(made));
  const id = made.json.id;
  const t = await say(m2, `tool: show_memory_item {"id":"${id}"}`, { title: "gate7 u54" });
  out("show_turn", t.terminal);
  out(
    "show_result",
    JSON.stringify(t.tools).includes(id) && !JSON.stringify(t.tools).includes("not_found"),
  );
  out("archive", code(await m2.call("POST", `/v1/memory/semantic/items/user/${id}/archive`, {})));
  out("undo", code(await m2.call("POST", `/v1/memory/semantic/items/user/${id}/restore`, {})));
  out(
    "archive_again",
    code(await m2.call("POST", `/v1/memory/semantic/items/user/${id}/archive`, {})),
  );
  const next = await say(m2, "No tools. Reply with the single word OK. When is lunch on Fridays?", {
    threadId: t.threadId,
  });
  out("next_turn", next.terminal);
  out(
    "next_run_has_it",
    (await contextOf(m2, t.threadId)).items.some((i) => i.id === id),
  );
}
