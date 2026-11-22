// ---- setup ----------------------------------------------------------------------------------------

/**
 * The owner joins team A as a Team admin (the browser's user: Site admin and Team admin, like
 * gate1's owner), the second member joins team B, every team enables the models, and the Site's
 * learning model is the fake (`fast`).
 */
async function setup() {
  const owner = await asOwner(null);
  const me = await owner.call("GET", "/v1/me");
  const ownerId = me.json.id ?? me.json.user?.id;
  const ad = await as("ad");
  if ((await owner.useTeam(TEAM_A)) !== 200) {
    const inv = await ad.call("POST", "/v1/team/invites", { email: OWNER.email, role: "member" });
    out("owner_invite", inv.status);
    out("owner_accept", (await owner.call("POST", `/v1/me/invites/${TEAM_A}/accept`)).status);
  }
  const role = await ad.call("PATCH", `/v1/team/members/${ownerId}`, { role: "team_admin" });
  out("owner_team_admin", `${role.status}:${role.json.role ?? role.json.code ?? "-"}`);
  // m2 also belongs to team B (portable preferences, break-glass fan-out).
  const m2b = await as("m2", null);
  if ((await m2b.useTeam(TEAM_B)) !== 200) {
    const bd = await as("bd");
    const inv = await bd.call("POST", "/v1/team/invites", {
      email: USERS.m2.email,
      role: "member",
    });
    out("m2_invite_b", inv.status);
    out("m2_accept_b", (await m2b.call("POST", `/v1/me/invites/${TEAM_B}/accept`)).status);
  }
  out("m2_in_b", await m2b.useTeam(TEAM_B));
  const put = await owner.call("PUT", "/v1/memory/settings?level=site", {
    settings: { learning_model_alias: config.alias },
  });
  out(
    "learning_model",
    `${put.status}:${put.json.settings?.learning_model_alias ?? put.json.code ?? "-"}`,
  );
  for (const [key, team] of [
    ["ad", TEAM_A],
    ["bd", TEAM_B],
  ]) {
    const admin = await as(key, team);
    const m = await admin.call("PUT", `/v1/team/models/${config.alias}`, {
      enabled: true,
      is_default: true,
    });
    out(`model_${key}`, m.status);
  }
  let inSync = false;
  for (let i = 0; i < 30 && !inSync; i += 1) {
    inSync = (await owner.call("GET", "/v1/site/models")).json.gateway?.in_sync === true;
    if (!inSync) await sleep(2_000);
  }
  out("gateway_in_sync", inSync);
  const eff = await ad.call("GET", "/v1/memory/settings?level=effective");
  out(
    "learn_available",
    `${eff.json.learn?.available}:${eff.json.learn?.alias ?? eff.json.learn?.reason ?? "-"}`,
  );
  out("owner_id", ownerId);
}
