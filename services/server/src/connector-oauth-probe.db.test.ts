import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { loadEnvelope } from "@kobe/db";
import type { ProbeCredentialKind, ProbeResult } from "./connectors/probe.js";
import { RefreshGate } from "./connectors/oauth/refresh-gate.js";
import { refreshConnector } from "./connectors/refresh.js";
import type { TestBrowser } from "./testing/browser.js";
import { FakeOauthServer } from "./testing/fake-oauth-server.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-784 (P2-13, owner decision 2026-11-22: mirror KOBE-431 for OAuth). An `oauth` connector is
 * probed with the acting site admin's own OAuth grant when they pin it, and with `pinned_by`'s
 * grant (refreshed through the leased refresh) for the periodic drift check; never a member's.
 * The token goes only to the proxy's probe, as an access token; the choice is audited as
 * `admin_oauth` without the value. With no grant, a server that wants one fails the pin with a
 * message telling the admin to connect their own account first.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/site/connectors";
const GRANTS = "/v1/connector-grants";
const team = randomUUID();
const fake = new FakeOauthServer();
let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
let rootId = "";
let connectorId = "";
/** What each probe was sent. */
const probes: { secret: string | undefined; kind: ProbeCredentialKind | undefined }[] = [];
const tools = [{ name: "a", description: "d", inputSchema: { type: "object" } }];

/** Like a remote MCP server under the MCP authorization spec: only a live access token lists. */
const answer = (secret: string | undefined, kind: ProbeCredentialKind | undefined): ProbeResult =>
  kind === "access_token" && fake.issued.some((t) => t.accessToken === secret)
    ? { ok: true, tools }
    : { ok: false, failure: "auth_required" };

beforeAll(async () => {
  await fake.start();
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "d".repeat(48) })),
    connectors: {
      allowHttp: true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: [],
      addresses: withTestLoopback(),
    },
    connectorProbe: {
      probe: async (_url, secret, _id, kind) => {
        probes.push({ secret, kind });
        return answer(secret, kind);
      },
    },
  });
  rootId = await h.createUser("root@oprobe.test", "admin");
  const aliceId = await h.createUser("alice@oprobe.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'op', 'op')`, [team]);
  for (const [user, role] of [
    [rootId, "team_admin"],
    [aliceId, "member"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      user,
      role,
    ]);
  }
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ('oprobe', $1, 'oauth') RETURNING id`,
    [fake.mcpUrl],
  );
  connectorId = must(rows[0]).id;
  await h.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
    [team, connectorId, rootId],
  );
  root = await h.signIn("root@oprobe.test");
  alice = await h.signIn("alice@oprobe.test");
  for (const b of [root, alice]) {
    await b.put("/v1/me/teams/active", { teamId: team });
    b.team = team;
  }
});
afterAll(async () => {
  await h?.close();
  await fake.close();
});

const db = () => h.deps.database.db;
async function connect(who: TestBrowser) {
  const started = await who.post(`${GRANTS}/${connectorId}/oauth/start`);
  expect(started.status, started.text).toBe(200);
  const back = await fake.authorize(
    (started.json as { authorization_url: string }).authorization_url,
  );
  const done = await who.get(`${GRANTS}/oauth/callback${back.search}`);
  expect(done.headers.get("location")).toContain("connected");
  return must(fake.issued.at(-1));
}
const choices = async () =>
  (
    await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'mcp.connector.probe_credential'
          AND target->>'connectorId' = $1 ORDER BY seq`,
      [connectorId],
    )
  ).rows.map((r) => r.target);
const replica = () => ({
  io: { policy: h.deps.connectorUrlPolicy, timeoutMs: 10_000 },
  gate: new RefreshGate(),
});

describe("pinning an OAuth connector", () => {
  it("without the admin's own grant: fails with a message to connect their account first", async () => {
    const pinned = await root.post(`${BASE}/${connectorId}/pin`);
    expect(pinned.status).toBe(502);
    expect(pinned.json.pin).toMatchObject({ ok: false, failure: "auth_required" });
    expect(pinned.json.pin.message).toMatch(/connect your own account/i);
    expect(probes.at(-1)).toEqual({ secret: undefined, kind: undefined });
  });

  it("probes with the acting admin's own access token and records them as pinned_by", async () => {
    const memberTokens = await connect(alice);
    const rootTokens = await connect(root);
    const pinned = await root.post(`${BASE}/${connectorId}/pin`);
    expect(pinned.json.pin, pinned.text).toEqual({ ok: true, tools: 1 });
    expect(probes.at(-1)).toEqual({ secret: rootTokens.accessToken, kind: "access_token" });
    expect(probes.some((p) => p.secret === memberTokens.accessToken)).toBe(false);
    const { rows } = await h.admin.query<{ pinned_by: string }>(
      `SELECT pinned_by FROM connectors WHERE id = $1`,
      [connectorId],
    );
    expect(must(rows[0]).pinned_by).toBe(rootId);
    expect((await choices()).at(-1)).toEqual({
      connectorId,
      name: "oprobe",
      purpose: "pin",
      credential: "admin_oauth",
      adminId: rootId,
    });
    const audit = JSON.stringify((await h.admin.query(`SELECT target FROM audit_log`)).rows);
    expect(audit).not.toContain(rootTokens.accessToken);
  });
});

describe("the periodic drift check of an OAuth connector", () => {
  it("probes with pinned_by's grant, refreshing an expired token through the leased refresh", async () => {
    await h.admin.query(
      `UPDATE connector_grants SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [rootId],
    );
    const before = fake.refreshRequests.length;
    const outcome = await refreshConnector(db(), h.deps.connectorProbe, connectorId, {
      envelope: h.deps.envelope,
      oauthRefresh: replica(),
    });
    expect(outcome.status).toBe("unchanged");
    expect(fake.refreshRequests.length).toBe(before + 1);
    expect(probes.at(-1)).toEqual({
      secret: must(fake.issued.at(-1)).accessToken,
      kind: "access_token",
    });
    expect((await choices()).at(-1)).toMatchObject({
      purpose: "refresh",
      credential: "admin_oauth",
      adminId: rootId,
    });
  });

  it("never falls back to a member's grant: without the admin's it skips as auth_required", async () => {
    expect((await root.delete(`${GRANTS}/${connectorId}`)).status).toBe(204);
    const seen = probes.length;
    const outcome = await refreshConnector(db(), h.deps.connectorProbe, connectorId, {
      envelope: h.deps.envelope,
      oauthRefresh: replica(),
    });
    expect(outcome).toEqual({ status: "skipped", reason: "auth_required" });
    expect(probes.slice(seen)).toEqual([{ secret: undefined, kind: undefined }]);
    expect((await choices()).at(-1)).toMatchObject({ purpose: "refresh", credential: "none" });
  });
});
