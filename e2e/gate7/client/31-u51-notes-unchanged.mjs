// ---- U51: Notes unchanged -----------------------------------------------------------------------

async function u51() {
  const ad = await as("ad");
  const path = `notes/gate7-${N}.md`;
  const w = await say(
    ad,
    `tool: remember {"scope":"user","path":"${path}","content":"gate7 ${N} note body"}`,
    { title: "gate7 u51" },
  );
  out("remember", w.terminal);
  out(
    "memory_updated",
    w.memoryEvents.map((e) => `${e.scope}:${e.path}:v${e.version}`).join(",") || "-",
  );
  const r = await say(ad, `tool: recall {"scope":"user","path":"${path}"}`, {
    threadId: w.threadId,
  });
  out("recall", `${r.terminal}:${r.text.includes(`gate7 ${N} note body`)}`);
  const docId = w.memoryEvents[0]?.memory_doc_id;
  const doc = await ad.call("GET", `/v1/memory/${docId}`);
  out("notes_doc", `${doc.status}:${JSON.stringify(doc.json).includes(`gate7 ${N} note body`)}`);
  const tools = await say(ad, "tools?", { threadId: w.threadId });
  out(
    "tools",
    ["remember", "recall", "show_memory_item"]
      .map((n) => `${n}=${tools.text.includes(n)}`)
      .join(","),
  );
  if (docId) await ad.call("DELETE", `/v1/memory/${docId}`);
}
