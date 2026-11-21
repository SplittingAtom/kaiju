// ---- U53: project facts go to the project's notes with the approval -----------------------------

async function u53() {
  const ad = await as("ad");
  const proj = await ad.call("POST", "/v1/projects", {
    name: `Gate7 ${N} project`,
    instructions: "Gate 7 project",
    member_user_ids: [],
  });
  out("project", `${proj.status}:${proj.json.my_role ?? proj.json.code ?? "-"}`);
  const text = `Gate7 ${N} this project ships through the blue lane`;
  const t = await say(
    ad,
    [
      "No tools. Reply with the single word OK.",
      directive({ statement: text, scope: "team", project_specific: true }),
    ].join("\n"),
    { title: "gate7 u53", projectId: proj.json.id },
  );
  out("turn", t.terminal);
  const p = await learn(ad, t.threadId);
  out("pass", passLine(p));
  const cand = p.candidates.find((c) => c.statement === text);
  out("destination", cand?.destination ?? "-");
  out(
    "notes_status",
    `${p.review.project_notes?.available ?? "-"}:${p.review.project_notes?.reason ?? "-"}`,
  );
  const prev = await ad.call(
    "POST",
    `/v1/memory/review/candidates/${cand?.id}/project-notes/preview`,
    {},
  );
  out("preview", `${prev.status}:${prev.json.section ?? prev.json.code ?? "-"}`);
  const forged = await ad.call("POST", `/v1/memory/review/candidates/${cand?.id}/project-notes`, {
    base_version: prev.json.base_version ?? 0,
    approval: `${prev.json.approval ?? "x"}x`,
    statement: `${text} (forged)`,
  });
  out("forged", code(forged));
  const add = await ad.call("POST", `/v1/memory/review/candidates/${cand?.id}/project-notes`, {
    base_version: prev.json.base_version,
    approval: prev.json.approval,
  });
  out("added", `${add.status}:${add.json.version ?? add.json.code ?? "-"}`);
  const doc = await ad.call("GET", `/v1/memory/${add.json.memory_doc_id}`);
  out("notes_has_line", `${doc.status}:${JSON.stringify(doc.json).includes(text)}`);
}
