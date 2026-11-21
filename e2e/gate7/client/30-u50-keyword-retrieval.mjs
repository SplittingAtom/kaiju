// ---- U50: keyword retrieval without embeddings ---------------------------------------------------

async function u50() {
  const owner = await asOwner(TEAM_A);
  const v = await owner.call("GET", "/v1/memory/vectors");
  out("vectors", `${v.status}:model=${v.json.model ?? "none"}:state=${v.json.model_state ?? "-"}`);
  const ad = await as("ad");
  const text = `Gate7 ${N} the quokka enclosure is behind the north gate`;
  const made = await create(ad, { scope: "user", kind: "fact", statement: text });
  out("item", code(made));
  const t1 = await say(
    ad,
    `No tools. Reply with the single word OK. Where is the quokka enclosure?`,
    { title: "gate7 u50" },
  );
  out("keyword_turn", t1.terminal);
  out(
    "keyword_pick",
    (await contextOf(ad, t1.threadId)).items.some((i) => i.id === made.json.id),
  );
  const t2 = await say(
    ad,
    "No tools. Reply with the single word OK. Where do the small marsupials live?",
    { title: "animals" }, // a new thread: earlier messages and the title count in the query
  );
  out("paraphrase_turn", t2.terminal);
  out(
    "paraphrase_pick",
    (await contextOf(ad, t2.threadId)).items.some((i) => i.id === made.json.id),
  );
  await ad.call("POST", `/v1/memory/semantic/items/user/${made.json.id}/archive`, {});
}
