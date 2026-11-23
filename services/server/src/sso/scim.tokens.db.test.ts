import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { TestBrowser } from "../testing/browser.js";
import { PUBLIC_URL } from "../testing/harness.js";
import { OPERATION_LIMITS } from "../operation-limits.js";
import { expectRateLimited, fillLimit } from "../testing/operation-limits.js";
import {
  SCIM,
  SCIM_TYPE,
  ERROR,
  h,
  owner,
  member,
  ownerId,
  providers,
  tokens,
  scim,
  newToken,
  auditRows,
  validatorUser,
  useScimHarness,
} from "./scim.test-helpers.js";

useScimHarness();

describe("SCIM tokens in the Site console", () => {
  it("limits creating and rotating per Site admin (KOBE-813)", async () => {
    const limit = OPERATION_LIMITS.scimTokenCreate;
    await fillLimit(h.admin, limit, ownerId);
    const before = await h.admin.query("SELECT count(*)::int AS n FROM scim_tokens");
    const created = await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens`);
    expectRateLimited(created, limit);
    const list = await owner.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    const live = list.json.tokens.find((t: any) => !t.revokedAt);
    const rotated = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${live.id}/rotate`,
    );
    expectRateLimited(rotated, limit);
    const after = await h.admin.query("SELECT count(*)::int AS n FROM scim_tokens");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("shows a token once, stores only its hash, and audits the credential id", async () => {
    const res = await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens`);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const token: string = res.json.token;
    expect(token).toMatch(/^kobe_scim_[A-Za-z0-9_-]{43}$/);
    expect(res.json.baseUrl).toBe(`${PUBLIC_URL}/v1/scim/v2/fabrikam`);
    const list = await owner.get(`/v1/site/sso/providers/${providers.fabrikam}/scim`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(token.slice(14));
    expect(list.json.tokens[0]).toEqual({
      id: res.json.credential.id,
      prefix: token.slice(0, 14),
      createdAt: expect.any(String),
      lastUsedAt: null,
      revokedAt: null,
    });
    const stored = await h.admin.query("SELECT token_hash FROM scim_tokens WHERE id = $1", [
      res.json.credential.id,
    ]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(token);
    const audits = await auditRows("identity.scim.token.created");
    expect(audits.at(-1).target).toEqual({
      providerId: providers.fabrikam,
      credentialId: res.json.credential.id,
    });
    const all = await h.admin.query("SELECT target::text AS t FROM audit_log");
    expect(all.rows.some((r) => r.t.includes(token.slice(10)))).toBe(false);
    // Two live now: a third is refused until one is revoked.
    const third = await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens`);
    expect(third.status).toBe(409);
    expect(third.json.code).toBe("too_many_tokens");
    const revoked = await owner.post(
      `/v1/site/sso/providers/${providers.fabrikam}/scim/tokens/${res.json.credential.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
  });

  it("rotates: the old token works until it is revoked, then gets 401 (ac-3)", async () => {
    const first = await newToken("contoso");
    expect((await scim("GET", "/contoso/Users", first.token)).status).toBe(200);
    const rotated = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/rotate`,
    );
    // contoso already had one live token from beforeAll: rotation can't make a third.
    expect(rotated.status).toBe(409);
    const list = await owner.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    const original = list.json.tokens.find((t: any) => t.id !== first.id && !t.revokedAt);
    await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${original.id}/revoke`,
    );
    expect((await scim("GET", "/contoso/Users", tokens.contoso)).status).toBe(401);
    const again = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/rotate`,
    );
    expect(again.status).toBe(201);
    expect(again.json.replaces).toBe(first.id);
    // Both work during the rotation.
    expect((await scim("GET", "/contoso/Users", first.token)).status).toBe(200);
    expect((await scim("GET", "/contoso/Users", again.json.token)).status).toBe(200);
    const done = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/revoke`,
    );
    expect(done.json.credential.revokedAt).toEqual(expect.any(String));
    const revoked = await scim("GET", "/contoso/Users", first.token);
    expect(revoked.status).toBe(401);
    expect(revoked.json.schemas).toEqual([ERROR]);
    expect(revoked.headers.get("www-authenticate")).toContain("Bearer");
    const twice = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/revoke`,
    );
    expect(twice.status).toBe(409);
    tokens.contoso = again.json.token;
    const used = await owner.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    expect(used.json.tokens.find((t: any) => t.id === again.json.credential.id).lastUsedAt).toEqual(
      expect.any(String),
    );
    expect((await auditRows("identity.scim.token.revoked")).length).toBeGreaterThanOrEqual(2);
  });

  it("KOBE-785: records a token's use at most once a minute", async () => {
    const { token, id } = await newToken("fabrikam");
    const lastUsed = async () =>
      (
        await h.admin.query<{ at: Date | null }>(
          `SELECT last_used_at AS at FROM scim_tokens WHERE id = $1`,
          [id],
        )
      ).rows[0]?.at ?? null;
    expect((await scim("GET", "/fabrikam/Users", token)).status).toBe(200);
    const first = await lastUsed();
    expect(first).not.toBeNull();
    // A second request within the minute authenticates without writing the row again.
    const xmin = async () =>
      (
        await h.admin.query<{ x: string }>(
          `SELECT xmin::text AS x FROM scim_tokens WHERE id = $1`,
          [id],
        )
      ).rows[0]?.x;
    const before = await xmin();
    expect((await scim("GET", "/fabrikam/Users", token)).status).toBe(200);
    expect(await xmin()).toBe(before);
    expect(await lastUsed()).toEqual(first);
    // Older than a minute: the next request records it again.
    await h.admin.query(
      `UPDATE scim_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = $1`,
      [id],
    );
    const stale = await lastUsed();
    expect((await scim("GET", "/fabrikam/Users", token)).status).toBe(200);
    expect((await lastUsed())?.getTime()).toBeGreaterThan(stale?.getTime() ?? 0);
    await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens/${id}/revoke`);
    expect((await scim("GET", "/fabrikam/Users", token)).status).toBe(401);
  });

  it("is for site.users.manage only", async () => {
    const path = `/v1/site/sso/providers/${providers.contoso}/scim`;
    expect((await member.get(path)).status).toBe(403);
    expect((await member.post(`${path}/tokens`)).status).toBe(403);
  });
});

describe("authentication and the provider boundary", () => {
  it("accepts only the provider's own bearer token (ac-4)", async () => {
    expect((await scim("GET", "/contoso/Users", undefined)).status).toBe(401);
    expect((await scim("GET", "/contoso/Users", "kobe_scim_nope")).status).toBe(401);
    // A token of provider B on provider A's URL.
    const cross = await scim("GET", "/contoso/Users", tokens.fabrikam);
    expect(cross.status).toBe(401);
    const crossCreate = await scim("POST", "/contoso/Users", tokens.fabrikam, validatorUser("x"));
    expect(crossCreate.status).toBe(401);
    // An unknown slug looks the same as a wrong token.
    expect((await scim("GET", "/nobody/Users", tokens.contoso)).status).toBe(401);
  });

  it("counts failures without a trusted client IP per provider, and reports them (KOBE-812)", async () => {
    // Only the trusted proxy itself in X-Forwarded-For: no client address can be resolved.
    const noIp = { "x-forwarded-for": "127.0.0.1" };
    expect((await scim("GET", "/contoso/Users", "kobe_scim_nope", undefined, noIp)).status).toBe(
      401,
    );
    expect((await scim("GET", "/nobody/Users", "kobe_scim_nope", undefined, noIp)).status).toBe(
      401,
    );
    const { rows } = await h.admin.query(
      `SELECT key FROM kobe_rate_limits WHERE key LIKE 'kobe:scim-auth-fail:%' ORDER BY key`,
    );
    const keys = rows.map((r: { key: string }) => r.key);
    expect(keys).toContain("kobe:scim-auth-fail:no-ip:contoso");
    expect(keys).toContain("kobe:scim-auth-fail:no-ip:nobody");
    expect(keys).not.toContain("kobe:scim-auth-fail:unknown");
    await h.deps.background.idle();
    expect(await h.deps.clientIps.seen()).not.toBeNull();
    // The provider's own token is not held up by that bucket.
    expect((await scim("GET", "/contoso/Users", tokens.contoso, undefined, noIp)).status).toBe(200);
  });

  it("never authenticates with a session cookie", async () => {
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await scim("GET", "/contoso/Users", undefined, undefined, {
      cookie,
      origin: PUBLIC_URL,
    });
    expect(res.status).toBe(401);
  });

  it("refuses a turned-off provider's token with 403", async () => {
    const res = await scim("GET", "/dormant/Users", tokens.dormant);
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/turned off/);
  });

  it("answers 404 for everything when auth.sso.enabled is false", async () => {
    const off = { ...h.deps.sso, settings: { ...h.deps.sso.settings, enabled: false } };
    const app = createApp({ ...h.deps, sso: off });
    for (const path of ["/contoso/Users", "/contoso/ServiceProviderConfig"]) {
      const res = await app.request(`${PUBLIC_URL}${SCIM}${path}`, {
        headers: { authorization: `Bearer ${tokens.contoso}` },
      });
      expect(res.status).toBe(404);
    }
    const b = new TestBrowser(app, PUBLIC_URL);
    for (const [k, v] of owner.cookies) b.cookies.set(k, v);
    const tokensRoute = await b.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    expect(tokensRoute.status).toBe(404);
  });

  it("rate limits each token at 600 requests a minute", async () => {
    const t = await newToken("fabrikam");
    await h.admin.query(
      "INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, 600, $2, $2::bigint + 3600000)",
      [`kobe:scim:${t.id}`, Date.now()],
    );
    const res = await scim("GET", "/fabrikam/Users", t.token);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain(SCIM_TYPE);
    expect(res.json.schemas).toEqual([ERROR]);
    // Other tokens keep their own budget.
    expect((await scim("GET", "/fabrikam/Users", tokens.fabrikam)).status).toBe(200);
  });
});

describe("discovery endpoints", () => {
  it("serve ServiceProviderConfig, ResourceTypes and Schemas as scim+json", async () => {
    const spc = await scim("GET", "/contoso/ServiceProviderConfig", tokens.contoso);
    expect(spc.status).toBe(200);
    expect(spc.headers.get("content-type")).toContain(SCIM_TYPE);
    expect(spc.json).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
    const types = await scim("GET", "/contoso/ResourceTypes", tokens.contoso);
    expect(types.json.Resources.map((r: any) => r.id)).toEqual(["User"]);
    const schemas = await scim("GET", "/contoso/Schemas", tokens.contoso);
    expect(schemas.json.Resources[0].id).toBe("urn:ietf:params:scim:schemas:core:2.0:User");
    // No Groups until SSO-8.
    expect((await scim("GET", "/contoso/Groups", tokens.contoso)).status).toBe(404);
  });
});
