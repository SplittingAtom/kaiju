import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTestLoopback } from "@kaiju/address-policy/testing";
import { loadEnvelope } from "@kaiju/db";
import { logger } from "../logger.js";
import { createInternalApp } from "../routes/internal.js";
import type { TestBrowser } from "../testing/browser.js";
import { FakeOauthServer } from "../testing/fake-oauth-server.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { INTERNAL_KEY, activeSandbox, mcpToken, MCP_VERIFY_KEYS } from "../testing/mcp-fixtures.js";

/**
 * Per-user OAuth grants (KOBE-109) against a fake authorization server following the MCP
 * 2026-07-28 authorization spec: discovery, PKCE S256, state bound to user/team/connector, resource
 * and iss checks, tokens sealed at rest and never returned or logged.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/connector-grants";
const CALLBACK = `${BASE}/oauth/callback`;
const teamT = randomUUID();
const teamU = randomUUID();
const fake = new FakeOauthServer();
let h: Harness;
let alice: TestBrowser;
let bob: TestBrowser;
let carol: TestBrowser;
let aliceId = "";
let oauthConnector = "";
let keyConnector = "";
let internal: ReturnType<typeof createInternalApp>;
const logged: string[] = [];

async function connector(name: string, authKind: string, url: string, teams: string[]) {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, $2, $3) RETURNING id`,
    [`${name}-${randomUUID().slice(0, 6)}`, url, authKind],
  );
  const id = rows[0]?.id ?? "";
  for (const team of teams) {
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, aliceId],
    );
  }
  return id;
}

beforeAll(async () => {
  await fake.start();
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  const loaded = must(loadEnvelope({ KAIJU_ENVELOPE_KEY: "e".repeat(48) }));
  h = await openHarness({
    envelope: loaded,
    connectors: {
      allowHttp: true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: [],
      // Loopback (the local fake) is never allowed by a list (KOBE-694).
      addresses: withTestLoopback(),
    },
  });
  aliceId = await h.createUser("alice@oauth.test");
  const bobId = await h.createUser("bob@oauth.test");
  const carolId = await h.createUser("carol@oauth.test");
  for (const [id, slug] of [
    [teamT, "t"],
    [teamU, "u"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [team, user] of [
    [teamT, aliceId],
    [teamT, bobId],
    [teamU, carolId],
  ] as const) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, user],
    );
  }
  oauthConnector = await connector("oauthy", "oauth", fake.mcpUrl, [teamT]);
  keyConnector = await connector("keyed", "api_key", fake.mcpUrl, [teamT]);
  alice = await h.signIn("alice@oauth.test");
  bob = await h.signIn("bob@oauth.test");
  carol = await h.signIn("carol@oauth.test");
  for (const [who, team] of [
    [alice, teamT],
    [bob, teamT],
    [carol, teamU],
  ] as const) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
  internal = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: h.deps.mcp,
    auth: {
      db: h.deps.database.db,
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      liveness: { isLive: () => Promise.resolve(true) },
    },
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
  await fake.close();
});

const start = (who: TestBrowser, connectorId = oauthConnector) =>
  who.post(`${BASE}/${connectorId}/oauth/start`);

/** Start + the browser round trip through the fake AS; returns the callback path and params. */
async function authorizeFor(who: TestBrowser, connectorId = oauthConnector) {
  const started = await start(who, connectorId);
  expect(started.status, started.text).toBe(200);
  const authorizationUrl = (started.json as { authorization_url: string }).authorization_url;
  const back = await fake.authorize(authorizationUrl);
  return { authorizationUrl: new URL(authorizationUrl), back, path: back.pathname + back.search };
}
const callbackPath = (back: URL) => `${CALLBACK}${back.search}`;

const grantFor = async (team: string, user: string, connectorId: string) => {
  const res = await internal.request(`/internal/v1/mcp/connectors/${connectorId}/grant`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_KEY}`,
      "kobe-sandbox-token": mcpToken({
        sandboxId: await activeSandbox(h.admin, team, user),
        teamId: team,
        userId: user,
      }),
    },
  });
  return { status: res.status, text: await res.text() };
};

describe("connecting an OAuth connector", () => {
  it("runs the full flow and seals the tokens", async () => {
    const { authorizationUrl, back } = await authorizeFor(alice);
    const q = authorizationUrl.searchParams;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${fake.base}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(fake.mcpUrl);
    expect(q.get("redirect_uri")).toBe(`http://kaiju.test${CALLBACK}`);
    expect(q.get("scope")).toBe("tools");
    expect(q.get("state")?.length).toBeGreaterThan(40);
    expect(fake.registrations[0]).toMatchObject({
      redirect_uris: [`http://kaiju.test${CALLBACK}`],
    });

    const done = await alice.get(callbackPath(back));
    expect(done.status, done.text).toBe(303);
    expect(done.headers.get("location")).toContain("connector_oauth=connected");

    // PKCE: the verifier Kaiju sent at the token endpoint hashes to the challenge it announced.
    const token = fake.tokenRequests.at(-1);
    const verifier = token?.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(q.get("code_challenge"));
    expect(token?.get("resource")).toBe(fake.mcpUrl);
    expect(token?.get("redirect_uri")).toBe(`http://kaiju.test${CALLBACK}`);

    const tokens = must(fake.issued.at(-1));
    const { rows } = await h.admin.query<{ kind: string; sealed: string; expires_at: Date }>(
      `SELECT kind, sealed, expires_at FROM connector_grants WHERE user_id = $1 AND connector_id = $2`,
      [aliceId, oauthConnector],
    );
    expect(rows[0]?.kind).toBe("oauth");
    expect(rows[0]?.sealed.startsWith("e1.")).toBe(true);
    expect(rows[0]?.sealed).not.toContain(tokens.accessToken);
    expect(rows[0]?.sealed).not.toContain(tokens.refreshToken);
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

    const served = await grantFor(teamT, aliceId, oauthConnector);
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text)).toEqual({
      kind: "oauth",
      access_token: tokens.accessToken,
      source: "member",
    });
  });

  it("never returns or logs tokens, state secrets or the verifier", async () => {
    const tokens = must(fake.issued.at(-1));
    const list = await alice.get(BASE);
    expect(list.json).toMatchObject({
      grants: [{ connector_id: oauthConnector, kind: "oauth", hint: "••••" }],
    });
    const audit = await h.admin.query(`SELECT * FROM audit_log`);
    const verifier = fake.tokenRequests.at(-1)?.get("code_verifier") ?? "";
    const everything = JSON.stringify([list.text, audit.rows, logged]);
    for (const secret of [tokens.accessToken, tokens.refreshToken, verifier]) {
      expect(everything).not.toContain(secret);
    }
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(audit.rows.some((r) => JSON.stringify(r).includes("mcp.grant.added"))).toBe(true);
  });

  it("never serves another user's or another team's grant", async () => {
    const bobId =
      (
        await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
          "bob@oauth.test",
        ])
      ).rows[0]?.id ?? "";
    expect((await grantFor(teamT, bobId, oauthConnector)).status).toBe(404);
    expect((await bob.get(BASE)).json).toEqual({ grants: [] });
    const carolId =
      (
        await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
          "carol@oauth.test",
        ])
      ).rows[0]?.id ?? "";
    expect((await grantFor(teamU, carolId, oauthConnector)).status).toBe(404);
  });

  it("lets the owner remove the grant", async () => {
    expect((await alice.delete(`${BASE}/${oauthConnector}`)).status).toBe(204);
    expect((await grantFor(teamT, aliceId, oauthConnector)).status).toBe(404);
  });
});

describe("where the callback sends the browser (KOBE-835)", () => {
  let dave: TestBrowser;
  let siteAdmin: TestBrowser;

  beforeAll(async () => {
    const daveId = await h.createUser("dave@oauth.test");
    const adminId = await h.createUser("siteadmin@oauth.test", "admin");
    for (const user of [daveId, adminId]) {
      await h.admin.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [teamT, user],
      );
    }
    dave = await h.signIn("dave@oauth.test");
    siteAdmin = await h.signIn("siteadmin@oauth.test");
    for (const who of [dave, siteAdmin]) {
      expect((await who.put("/v1/me/teams/active", { teamId: teamT })).status).toBe(200);
      who.team = teamT;
    }
  });

  async function connectVia(who: TestBrowser, body?: unknown): Promise<URL> {
    const started = await who.post(`${BASE}/${oauthConnector}/oauth/start`, body);
    expect(started.status, started.text).toBe(200);
    const back = await fake.authorize(
      (started.json as { authorization_url: string }).authorization_url,
    );
    const done = await who.get(callbackPath(back));
    expect(done.status, done.text).toBe(303);
    const location = new URL(must(done.headers.get("location") ?? undefined));
    await who.delete(`${BASE}/${oauthConnector}`);
    return location;
  }

  it("returns to My connectors on Kaiju's own origin, with the result and connector only", async () => {
    const back = await connectVia(dave);
    expect(back.origin).toBe("http://kaiju.test");
    expect(back.pathname).toBe("/me/connectors");
    expect([...back.searchParams.keys()].sort()).toEqual(["connector", "connector_oauth"]);
    expect(back.searchParams.get("connector_oauth")).toBe("connected");
    expect(back.searchParams.get("connector")).toBe(oauthConnector);
  });

  it("returns a site admin who connected from the Site console to the connector registry", async () => {
    const back = await connectVia(siteAdmin, { return_to: "site" });
    expect(back.origin).toBe("http://kaiju.test");
    expect(back.pathname).toBe("/admin/site/connectors");
    expect(back.searchParams.get("connector_oauth")).toBe("connected");
  });

  it("sends a member who asks for the Site console to My connectors instead", async () => {
    const back = await connectVia(dave, { return_to: "site" });
    expect(back.pathname).toBe("/me/connectors");
  });

  it("refuses any other return target, never a URL", async () => {
    for (const body of [{ return_to: "https://evil.example/" }, { return_to: "/x" }, { x: 1 }]) {
      const res = await dave.post(`${BASE}/${oauthConnector}/oauth/start`, body);
      expect(res.status, res.text).toBe(400);
    }
  });

  it("says why a sign-in failed with a fixed reason code", async () => {
    const started = await dave.post(`${BASE}/${oauthConnector}/oauth/start`);
    const back = await fake.authorize(
      (started.json as { authorization_url: string }).authorization_url,
    );
    const res = await dave.get(
      `${CALLBACK}?error=access_denied&error_description=%3Cb%3Ehi%3C%2Fb%3E&state=${back.searchParams.get("state")}`,
    );
    const location = new URL(must(res.headers.get("location") ?? undefined));
    expect(location.pathname).toBe("/me/connectors");
    expect(location.searchParams.get("reason")).toBe("access_denied");
    expect(location.toString()).not.toContain("hi");
  });

  it("sends a member without a usable active workspace to My connectors with a fixed reason", async () => {
    const started = await dave.post(`${BASE}/${oauthConnector}/oauth/start`);
    const back = await fake.authorize(
      (started.json as { authorization_url: string }).authorization_url,
    );
    const daveId = must(
      (await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = 'dave@oauth.test'`))
        .rows[0]?.id,
    );
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamT,
      daveId,
    ]);
    try {
      const res = await dave.get(callbackPath(back));
      expect(res.status).toBe(303);
      const to = new URL(must(res.headers.get("location") ?? undefined));
      expect(to.pathname).toBe("/me/connectors");
      expect(Object.fromEntries(to.searchParams)).toEqual({
        connector_oauth: "failed",
        reason: "no_workspace",
      });
    } finally {
      await h.admin.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [teamT, daveId],
      );
    }
  });

  it("says whether Kaiju renews an OAuth sign-in by itself (refreshable)", async () => {
    const connectOnce = async () => {
      const started = await dave.post(`${BASE}/${oauthConnector}/oauth/start`);
      const back = await fake.authorize(
        (started.json as { authorization_url: string }).authorization_url,
      );
      await dave.get(callbackPath(back));
    };
    await connectOnce();
    // The access token ran out: still renewable, so not an expired sign-in.
    await h.admin.query(
      `UPDATE connector_grants SET expires_at = now() - interval '1 minute' WHERE connector_id = $1`,
      [oauthConnector],
    );
    expect((await dave.get(BASE)).json).toMatchObject({
      grants: [{ connector_id: oauthConnector, kind: "oauth", refreshable: true }],
    });
    await dave.delete(`${BASE}/${oauthConnector}`);
    fake.options = { omitRefreshToken: true };
    try {
      await connectOnce();
    } finally {
      fake.options = {};
    }
    const listed = await dave.get(BASE);
    expect(listed.json).toMatchObject({
      grants: [{ connector_id: oauthConnector, kind: "oauth", refreshable: false }],
    });
    expect(listed.text).not.toContain("rt-secret");
    await dave.delete(`${BASE}/${oauthConnector}`);
  });

  it("disconnects: removes the grant and audits it", async () => {
    const started = await dave.post(`${BASE}/${oauthConnector}/oauth/start`);
    const back = await fake.authorize(
      (started.json as { authorization_url: string }).authorization_url,
    );
    await dave.get(callbackPath(back));
    expect((await dave.get(BASE)).json).toMatchObject({
      grants: [{ connector_id: oauthConnector, kind: "oauth" }],
    });
    const before = Number(
      (
        await h.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed' AND team_id = $1`,
          [teamT],
        )
      ).rows[0]?.n,
    );
    expect((await dave.delete(`${BASE}/${oauthConnector}`)).status).toBe(204);
    expect((await dave.get(BASE)).json).toEqual({ grants: [] });
    const after = Number(
      (
        await h.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed' AND team_id = $1`,
          [teamT],
        )
      ).rows[0]?.n,
    );
    expect(after - before).toBe(1);
    // Nothing left to disconnect.
    expect((await dave.delete(`${BASE}/${oauthConnector}`)).status).toBe(404);
  });
});

describe("a connector pointed at another server", () => {
  const evil = "https://evil.example/mcp";
  it("never sends a token issued for the old server (refused and audited)", async () => {
    const { back } = await authorizeFor(alice);
    expect((await alice.get(callbackPath(back))).headers.get("location")).toContain("connected");
    const aliceUser = aliceId;
    expect((await grantFor(teamT, aliceUser, oauthConnector)).status).toBe(200);
    // A URL change that bypassed the registry (e.g. restored backup): the resource check holds.
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [oauthConnector, evil]);
    const served = await grantFor(teamT, aliceUser, oauthConnector);
    expect(served.status).toBe(503);
    expect(served.text).not.toContain(must(fake.issued.at(-1)).accessToken);
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'mcp.grant.refused'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain("at-secret");
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [
      oauthConnector,
      fake.mcpUrl,
    ]);
    await alice.delete(`${BASE}/${oauthConnector}`);
  });

  it("drops OAuth and API-key grants when the registry changes the URL", async () => {
    const { back } = await authorizeFor(alice);
    await alice.get(callbackPath(back));
    const bobUser = (
      await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob@oauth.test'`)
    ).rows[0]?.id;
    expect((await bob.put(`${BASE}/${keyConnector}`, { api_key: "k".repeat(20) })).status).toBe(
      201,
    );
    const count = async () =>
      (await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM connector_grants`)).rows[0]?.n;
    expect(await count()).toBe("2");
    await h.createUser("root@oauth.test", "owner");
    const root = await h.signIn("root@oauth.test");
    for (const id of [oauthConnector, keyConnector]) {
      const res = await root.patch(`/v1/site/connectors/${id}`, { url: `${fake.base}/moved` });
      expect(res.status, res.text).toBe(200);
    }
    expect(await count()).toBe("0");
    expect(bobUser).toBeDefined();
    const removed = await h.admin.query(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed'`,
    );
    expect(Number(removed.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    for (const id of [oauthConnector, keyConnector]) {
      await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [id, fake.mcpUrl]);
    }
  });
});

describe("connector lifecycle edge cases (KOBE-784)", () => {
  let site: TestBrowser;
  const grants = async () =>
    Number(
      (await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM connector_grants`)).rows[0]?.n,
    );
  const oauthClient = async (id = oauthConnector) =>
    (
      await h.admin.query<{ oauth_client: string | null }>(
        `SELECT oauth_client FROM connectors WHERE id = $1`,
        [id],
      )
    ).rows[0]?.oauth_client;

  beforeAll(async () => {
    await h.createUser("site@oauth.test", "admin");
    site = await h.signIn("site@oauth.test");
  });

  it("refuses a callback that arrives after the connector's URL changed (P2-27)", async () => {
    const { back } = await authorizeFor(alice);
    // A site admin points the connector elsewhere while alice is at the authorization server.
    const moved = await site.patch(`/v1/site/connectors/${oauthConnector}`, {
      url: `${fake.base}/moved`,
    });
    expect(moved.status, moved.text).toBe(200);
    const done = await alice.get(callbackPath(back));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toContain("connector_oauth=failed");
    expect(done.headers.get("location")).toContain("reason=not_available");
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [
      oauthConnector,
      fake.mcpUrl,
    ]);
  });

  it("registers one OAuth client per connector and redirect URI, again only after a URL change (P2-31)", async () => {
    await h.admin.query(`UPDATE connectors SET oauth_client = NULL WHERE id = $1`, [
      oauthConnector,
    ]);
    const before = fake.registrations.length;
    const first = await authorizeFor(alice);
    const second = await authorizeFor(bob);
    expect(fake.registrations.length).toBe(before + 1);
    const clientOf = (u: URL) => u.searchParams.get("client_id");
    expect(clientOf(second.authorizationUrl)).toBe(clientOf(first.authorizationUrl));
    // Stored sealed, never the secret in clear.
    const stored = must((await oauthClient()) ?? undefined);
    expect(stored.startsWith("e1.")).toBe(true);
    expect(stored).not.toContain(must(clientOf(first.authorizationUrl) ?? undefined));
    // The cached client still completes the flow (its secret is used at the token endpoint).
    expect((await alice.get(callbackPath(first.back))).headers.get("location")).toContain(
      "connected",
    );
    await alice.delete(`${BASE}/${oauthConnector}`);
    // A new URL drops the registration with the grants.
    await site.patch(`/v1/site/connectors/${oauthConnector}`, { url: `${fake.base}/moved` });
    expect(await oauthClient()).toBeNull();
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [
      oauthConnector,
      fake.mcpUrl,
    ]);
    await authorizeFor(alice);
    expect(fake.registrations.length).toBe(before + 2);
  });

  it("rate limits starting the OAuth flow per member (P2-31)", async () => {
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = (await start(carol, randomUUID())).status;
    expect(last).toBe(429);
    await h.admin.query(`DELETE FROM kobe_rate_limits WHERE key LIKE 'kobe:oauth-start:%'`);
  });

  it("changing the auth kind deletes the old grants, audited, and they do not come back (P2-30)", async () => {
    expect((await bob.put(`${BASE}/${keyConnector}`, { api_key: "b".repeat(20) })).status).toBe(
      201,
    );
    const { back } = await authorizeFor(alice);
    await alice.get(callbackPath(back));
    expect(await grants()).toBe(2);
    const removedBefore = Number(
      (
        await h.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed'`,
        )
      ).rows[0]?.n,
    );
    for (const [id, kind] of [
      [keyConnector, "none"],
      [oauthConnector, "api_key"],
    ] as const) {
      const res = await site.patch(`/v1/site/connectors/${id}`, { authKind: kind });
      expect(res.status, res.text).toBe(200);
    }
    expect(await grants()).toBe(0);
    expect(await oauthClient()).toBeNull();
    const removedAfter = Number(
      (
        await h.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed'`,
        )
      ).rows[0]?.n,
    );
    expect(removedAfter - removedBefore).toBe(2);
    // Switching back revives nothing.
    for (const [id, kind] of [
      [keyConnector, "api_key"],
      [oauthConnector, "oauth"],
    ] as const) {
      await site.patch(`/v1/site/connectors/${id}`, { authKind: kind });
    }
    expect(await grants()).toBe(0);
  });
});

describe("client metadata", () => {
  it("publishes Kaiju's Client ID Metadata Document without a session", async () => {
    const res = await h.app.request("http://kaiju.test/v1/oauth/client-metadata.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      client_id: "http://kaiju.test/v1/oauth/client-metadata.json",
      redirect_uris: [`http://kaiju.test${CALLBACK}`],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("refusals", () => {
  /** A refusal before the state opens: a 303 to My connectors with a fixed reason, nothing else. */
  const refusedTo = (res: { status: number; headers: Headers }, reason: string) => {
    expect(res.status).toBe(303);
    const to = new URL(must(res.headers.get("location") ?? undefined));
    expect(to.origin + to.pathname).toBe("http://kaiju.test/me/connectors");
    expect(Object.fromEntries(to.searchParams)).toEqual({ connector_oauth: "failed", reason });
  };

  it("refuses a state tampered with", async () => {
    const { back } = await authorizeFor(alice);
    back.searchParams.set("state", `${back.searchParams.get("state")}x`);
    refusedTo(await alice.get(callbackPath(back)), "invalid_state");
  });

  it("refuses a state minted for another user", async () => {
    const { back } = await authorizeFor(alice);
    refusedTo(await bob.get(callbackPath(back)), "invalid_state");
    expect((await bob.get(BASE)).json).toEqual({ grants: [] });
  });

  it("refuses a state used in another team", async () => {
    const { back } = await authorizeFor(alice);
    refusedTo(await carol.get(callbackPath(back)), "invalid_state");
  });

  it("refuses a callback without a state or with an unknown one", async () => {
    refusedTo(await alice.get(`${CALLBACK}?code=abc`), "invalid_state");
    refusedTo(await alice.get(`${CALLBACK}?code=abc&state=nonsense`), "invalid_state");
  });

  it("sends a signed-out browser to the sign-in page, keeping nothing of the request", async () => {
    const { back } = await authorizeFor(alice);
    const res = await h.app.request(`http://kaiju.test${callbackPath(back)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://kaiju.test/sign-in");
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("refuses a mismatching or missing iss (RFC 9207)", async () => {
    for (const iss of ["https://evil.example", null]) {
      const { back } = await authorizeFor(alice);
      if (iss === null) back.searchParams.delete("iss");
      else back.searchParams.set("iss", iss);
      const res = await alice.get(callbackPath(back));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("connector_oauth=failed");
    }
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("does not reuse an authorization code", async () => {
    const { back } = await authorizeFor(alice);
    expect((await alice.get(callbackPath(back))).headers.get("location")).toContain("connected");
    await alice.delete(`${BASE}/${oauthConnector}`);
    const replay = await alice.get(callbackPath(back));
    expect(replay.headers.get("location")).toContain("connector_oauth=failed");
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("shows an authorization error from the server without storing anything", async () => {
    const { back } = await authorizeFor(alice);
    const res = await alice.get(
      `${CALLBACK}?error=access_denied&state=${back.searchParams.get("state")}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("connector_oauth=failed");
  });

  it("starts only for an enabled oauth connector", async () => {
    expect((await start(alice, keyConnector)).status).toBe(422);
    expect((await start(carol)).status).toBe(404);
    expect((await start(alice, randomUUID())).status).toBe(404);
    const putKey = await alice.put(`${BASE}/${oauthConnector}`, { api_key: "x".repeat(20) });
    expect(putKey.status).toBe(422);
  });
});

describe("discovery checks", () => {
  const reset = () => {
    fake.options = {};
  };
  it.each([
    ["no S256 support", { pkce: false }],
    ["a resource that is not the connector", { prmResource: "https://other.example/mcp" }],
    ["an issuer that differs from the server's", { metadataIssuer: "https://other.example" }],
  ])("refuses %s", async (_name, options) => {
    fake.options = options;
    try {
      const res = await start(alice);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "oauth_unsupported" });
    } finally {
      reset();
    }
  });

  it("answers a malformed issuer with oauth_unsupported, not an error", async () => {
    fake.options = { prmAuthServer: "http://[bad" };
    try {
      const res = await start(alice);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "oauth_unsupported" });
    } finally {
      reset();
    }
  });

  it("fails without registration when the server offers none", async () => {
    fake.options = { dcr: false };
    // No client registered yet (KOBE-784 keeps one per connector once registered).
    await h.admin.query(`UPDATE connectors SET oauth_client = NULL`);
    try {
      expect((await start(alice)).status).toBe(422);
    } finally {
      reset();
    }
  });
});
