// ---- U49: retention, holds, offboarding, Site break-glass for portable preferences --------------

async function u49() {
  const owner = await asOwner(TEAM_B);
  const ms = await siteSettings(owner);
  out("retention_days", ms.retention_days ?? "-");
  out("site_retention", (await owner.call("GET", "/v1/site/retention")).status);
  const bd = await as("bd");
  out("team_retention", code(await bd.call("GET", "/v1/team/retention")));
  // A legal hold on one person in team B, placed and released (a single site admin may self-approve).
  const hold = await owner.call("POST", "/v1/site/legal-hold", {
    teamId: TEAM_B,
    userId: USERS.ob.userId,
    reason: `Gate7 ${N} litigation hold for the offboarding check`,
  });
  out("hold_request", code(hold));
  const holdId = hold.json.hold?.id;
  const placed = await owner.call("POST", `/v1/site/legal-hold/${holdId}/approve`);
  out("hold_active", `${placed.status}:${placed.json.hold?.status ?? placed.json.code ?? "-"}`);
  // Offboarding: ob leaves team B; their personal memory stays (30 days, and held).
  const ob = await as("ob");
  const mem = await create(ob, {
    scope: "user",
    kind: "fact",
    statement: `Gate7 ${N} offboarded person's note`,
  });
  out("ob_item", code(mem));
  out("remove_member", (await bd.call("DELETE", `/v1/team/members/${USERS.ob.userId}`)).status);
  const listed = await bd.call("GET", "/v1/team/offboarded");
  out(
    "offboarded_listed",
    `${listed.status}:${JSON.stringify(listed.json).includes(USERS.ob.userId)}`,
  );
  const kept = await inTeam(TEAM_B, async (tx, sql) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM semantic_memory_items
      WHERE team_id = ${TEAM_B} AND owner_user_id = ${USERS.ob.userId}`);
    return r.rows[0]?.n ?? 0;
  });
  out("ob_items_kept", kept);
  const rel = await owner.call("POST", `/v1/site/legal-hold/${holdId}/release`, {
    reason: `Gate7 ${N} matter closed, release`,
  });
  out("hold_release_request", code(rel));
  const released = await owner.call("POST", `/v1/site/legal-hold/${holdId}/release/approve`);
  out(
    "hold_released",
    `${released.status}:${released.json.hold?.status ?? released.json.code ?? "-"}`,
  );
  // Break-glass for portable preferences: two-person (self on a single-admin site), each read
  // audited in the Site log and in every workspace of the person (m2: teams A and B).
  const m2 = await as("m2");
  const pref = `Prefers gate7 ${N} break-glass coloured charts`;
  const p = await create(m2, {
    scope: "portable",
    kind: "preference",
    statement: pref,
    confirm_portable: true,
  });
  out("portable", code(p));
  const started = new Date().toISOString();
  const g = await owner.call("POST", "/v1/site/portable-break-glass", {
    subjectUserId: USERS.m2.userId,
    reason: `Gate7 ${N} investigation of a reported leak`,
    durationMinutes: 15,
  });
  out("grant_request", code(g));
  const grantId = g.json.grant?.id;
  const ap = await owner.call("POST", `/v1/site/portable-break-glass/${grantId}/approve`);
  out("grant_approve", `${ap.status}:${ap.json.grant?.status ?? ap.json.code ?? "-"}`);
  const read = await owner.call("GET", `/v1/site/portable-break-glass/${grantId}/items`);
  out("grant_read", `${read.status}:${JSON.stringify(read.json).includes(pref)}`);
  const fan = [];
  for (const [k, team] of [
    ["a", TEAM_A],
    ["b", TEAM_B],
  ]) {
    const rows = await auditActions(team, started);
    fan.push(
      `${k}=${rows.filter((r) => r.action === "governance.site_break_glass.read" && r.target.includes(grantId)).length}`,
    );
  }
  out("read_audited", fan.join(","));
  out(
    "grant_revoke",
    (await owner.call("POST", `/v1/site/portable-break-glass/${grantId}/revoke`)).status,
  );
  if (p.json.id)
    await m2.call("POST", `/v1/memory/semantic/items/portable/${p.json.id}/archive`, {});
}
