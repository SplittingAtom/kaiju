// ---- U52: the extractor's records -----------------------------------------------------------------

async function u52() {
  // Both teams' passes of this run (shard b learns in gate7-b; shard a in gate7-a), not the fixtures.
  const rows = [];
  for (const team of [TEAM_A, TEAM_B]) {
    rows.push(
      ...(await inTeam(team, async (tx, sql) => {
        const r = await tx.execute(sql`
          SELECT status, model_alias, prompt_version, usage FROM memory_learning_passes
           WHERE team_id = ${team} AND coalesce(error, '') <> 'gate7 rate-limit fixture'
           ORDER BY created_at DESC LIMIT 50`);
        return r.rows;
      })),
    );
  }
  out("passes", rows.length);
  out(
    "versions",
    [...new Set(rows.map((r) => `${r.prompt_version}/${r.model_alias}`))].join(",") || "-",
  );
  out(
    "recorded",
    rows.every(
      (r) => r.usage?.prompt_version === r.prompt_version && r.usage?.model_alias === r.model_alias,
    ),
  );
  out("failed", rows.filter((r) => r.status === "failed").length);
  const ad = await as("ad");
  const q = await ad.call("GET", "/v1/memory/quality/passes");
  out("quality_passes", `${q.status}:${oneLine(JSON.stringify(q.json)).slice(0, 200)}`);
}
