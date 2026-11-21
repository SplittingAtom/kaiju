import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import { sweepDepartedGrants } from "./connectors/grant-departures.js";
import { removeMemberInTx } from "./teams/members.js";
import { deactivateUser } from "./users/deactivation.js";
import { withTeam } from "@kobe/db";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * A member's connector grants end with their standing in the team (KOBE-696): removal (team admin,
 * Site admin, identity provider), deactivation (Site admin) and SCIM deprovisioning delete them with
 * an `mcp.grant.removed` audit row carrying the member and the reason; the offboarding sweep deletes
 * grants left behind (the one-off cleanup of grants from before KOBE-696).
 */
const teamT = randomUUID();
const teamU = randomUUID();
let h: Harness;
let owner: TestBrowser;
let ownerId = "";
let keyed = "";
let keyed2 = "";
let provider = "";

async function grant(team: string, user: string, connector: string): Promise<void> {
  await h.admin.query(
    `INSERT INTO connector_grants (team_id, user_id, connector_id, sealed, key_id, hint)
     VALUES ($1, $2, $3, 'e1.k.sealed', 'k', '••••abcd') ON CONFLICT DO NOTHING`,
    [team, user, connector],
  );
}

async function grantsOf(user: string): Promise<string[]> {
  const { rows } = await h.admin.query<{ team_id: string; connector_id: string }>(
    `SELECT team_id, connector_id FROM connector_grants WHERE user_id = $1 ORDER BY 1, 2`,
    [user],
  );
  return rows.map((r) => `${r.team_id}/${r.connector_id}`);
}

interface RemovedRow {
  team_id: string;
  actor_kind: string;
  actor_id: string | null;
  target: { connectorId: string; name: string; userId?: string; reason?: string };
}

async function removedAudits(user: string): Promise<RemovedRow[]> {
  const { rows } = await h.admin.query<RemovedRow>(
    `SELECT team_id, actor_kind, actor_id, target FROM audit_log
      WHERE action = 'mcp.grant.removed' AND target->>'userId' = $1 ORDER BY seq`,
    [user],
  );
  return rows;
}

async function member(team: string, user: string, role = "member"): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [team, user, role],
  );
}

async function connector(name: string): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, 'https://mcp.example.com/mcp', 'api_key') RETURNING id`,
    [`${name}-${randomUUID().slice(0, 6)}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("connector insert returned nothing");
  for (const team of [teamT, teamU]) {
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, ownerId],
    );
  }
  return id;
}

/** A member of both teams with a key for both connectors in each. */
async function memberWithGrants(email: string): Promise<string> {
  const id = await h.createUser(email);
  for (const team of [teamT, teamU]) {
    await member(team, id);
    await grant(team, id, keyed);
    await grant(team, id, keyed2);
  }
  return id;
}

beforeAll(async () => {
  h = await openHarness();
  ownerId = await h.createUser("owner@departures.test", "owner");
  for (const [id, slug] of [
    [teamT, "dep-t"],
    [teamU, "dep-u"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
    await member(id, ownerId, "team_admin");
  }
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim,
       access_claim, managed_by, enabled)
     VALUES ('dep-idp', 'IdP', 'oidc', 'https://idp.example.test/dep', 'kobe', 'sub', 'roles', 'helm', true)
     RETURNING id`,
  );
  provider = rows[0]?.id ?? "";
  keyed = await connector("keyed");
  keyed2 = await connector("keyed2");
  owner = await h.signIn("owner@departures.test");
  expect((await owner.put("/v1/me/teams/active", { teamId: teamT })).status).toBe(200);
  owner.team = teamT;
});
afterAll(async () => {
  await h?.close();
});

describe("removing a member deletes their grants in that team (ac-2)", () => {
  it("a team admin's removal: the team's grants go, audited with the reason; other teams keep theirs", async () => {
    const alice = await memberWithGrants("alice@departures.test");
    expect((await owner.delete(`/v1/team/members/${alice}`)).status).toBe(204);
    expect(await grantsOf(alice)).toEqual([`${teamU}/${keyed}`, `${teamU}/${keyed2}`].sort());
    const rows = await removedAudits(alice);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.team_id).toBe(teamT);
      expect(row).toMatchObject({ actor_kind: "user", actor_id: ownerId });
      expect(row.target).toMatchObject({ userId: alice, reason: "member_removed" });
    }
    expect(rows.map((r) => r.target.connectorId).sort()).toEqual([keyed, keyed2].sort());
  });

  it("a Site admin's removal from the Site console does the same", async () => {
    const bob = await memberWithGrants("bob@departures.test");
    const res = await owner.delete(`/v1/site/teams/${teamU}/members/${bob}`);
    expect(res.status, res.text).toBe(204);
    expect(await grantsOf(bob)).toEqual([`${teamT}/${keyed}`, `${teamT}/${keyed2}`].sort());
    const rows = await removedAudits(bob);
    expect(rows.map((r) => [r.team_id, r.target.reason])).toEqual([
      [teamU, "member_removed"],
      [teamU, "member_removed"],
    ]);
  });

  it("an identity provider's removal is recorded as deprovisioned", async () => {
    const carol = await memberWithGrants("carol@departures.test");
    // The provider's access mappings manage carol's membership in T (SSO10).
    await h.admin.query(
      `UPDATE team_members SET added_via = $1 WHERE team_id = $2 AND user_id = $3`,
      [`idp:${provider}`, teamT, carol],
    );
    const result = await runWithAuditContext(
      { actor: { kind: "system", id: null }, ip: null, userAgent: null },
      () =>
        withTeam(h.deps.database.db, teamT, (tx) =>
          removeMemberInTx(tx, teamT, carol, { idp: provider }),
        ),
    );
    expect(result).toEqual({ ok: true });
    expect(await grantsOf(carol)).toHaveLength(2);
    expect((await removedAudits(carol)).map((r) => r.target.reason)).toEqual([
      "deprovisioned",
      "deprovisioned",
    ]);
  });

  it("a re-added member has no key until they enter it again", async () => {
    const dave = await memberWithGrants("dave@departures.test");
    expect((await owner.delete(`/v1/team/members/${dave}`)).status).toBe(204);
    await member(teamT, dave);
    expect((await grantsOf(dave)).filter((g) => g.startsWith(teamT))).toEqual([]);
  });
});

describe("deactivation deletes the user's grants in every team (ac-2)", () => {
  it("a Site admin's deactivation: reason deactivated, actor system", async () => {
    const erin = await memberWithGrants("erin@departures.test");
    const res = await owner.post(`/v1/site/users/${erin}/deactivate`, {});
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ incompleteSteps: [] });
    expect(await grantsOf(erin)).toEqual([]);
    const rows = await removedAudits(erin);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.team_id))).toEqual(new Set([teamT, teamU]));
    for (const row of rows) {
      expect(row).toMatchObject({ actor_kind: "system", target: { reason: "deactivated" } });
    }
    // Reactivation does not bring them back.
    expect((await owner.post(`/v1/site/users/${erin}/reactivate`, {})).status).toBe(200);
    expect(await grantsOf(erin)).toEqual([]);
  });

  it("SCIM deprovisioning: reason deprovisioned", async () => {
    const frank = await memberWithGrants("frank@departures.test");
    const did = await runWithAuditContext(
      { actor: { kind: "system", id: null }, ip: null, userAgent: null },
      () => deactivateUser(h.deps.database.db, frank, { via: `scim:${provider}` }),
    );
    expect(did).toBe(true);
    expect(await h.deps.lifecycle.emit("deactivated", frank)).toEqual([]);
    expect(await grantsOf(frank)).toEqual([]);
    const reasons = (await removedAudits(frank)).map((r) => r.target.reason);
    expect(reasons).toEqual(["deprovisioned", "deprovisioned", "deprovisioned", "deprovisioned"]);
  });
});

describe("the offboarding sweep deletes grants left behind (ac-3)", () => {
  let gone = "";
  let inactive = "";
  let active = "";

  beforeEach(async () => {
    gone = await memberWithGrants(`gone-${randomUUID().slice(0, 6)}@departures.test`);
    inactive = await memberWithGrants(`inactive-${randomUUID().slice(0, 6)}@departures.test`);
    active = await memberWithGrants(`active-${randomUUID().slice(0, 6)}@departures.test`);
    // As before KOBE-696: the membership or the account ended and the grants stayed.
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamT,
      gone,
    ]);
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [inactive]);
  });

  it("deletes non-members' and deactivated users' grants, keeps active members', and is idempotent", async () => {
    await sweepDepartedGrants(h.deps.database.db);
    expect(await grantsOf(gone)).toEqual([`${teamU}/${keyed}`, `${teamU}/${keyed2}`].sort());
    expect(await grantsOf(inactive)).toEqual([]);
    expect(await grantsOf(active)).toHaveLength(4);
    expect(
      (await removedAudits(gone)).map((r) => [r.team_id, r.actor_kind, r.target.reason]),
    ).toEqual([
      [teamT, "system", "member_removed"],
      [teamT, "system", "member_removed"],
    ]);
    expect(new Set((await removedAudits(inactive)).map((r) => r.target.reason))).toEqual(
      new Set(["deactivated"]),
    );
    expect(await sweepDepartedGrants(h.deps.database.db)).toBe(0);
  });

  it("runs as part of the offboarding sweep", async () => {
    const summary = await h.deps.offboarding.sweep();
    expect(summary.grants).toBeGreaterThanOrEqual(6);
    expect(await grantsOf(gone)).toHaveLength(2);
    expect(await grantsOf(inactive)).toEqual([]);
    expect(await grantsOf(active)).toHaveLength(4);
  });
});
