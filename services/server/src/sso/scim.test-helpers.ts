// Shared setup for the scim.*.db.test.ts files (split from scim.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { sessions, sessionSsoContexts, ssoProviders } from "@kaiju/db";
import { loadSsoSettings } from "./settings.js";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, PUBLIC_URL, type Harness } from "../testing/harness.js";
import { OPERATION_LIMITS } from "../operation-limits.js";
import { clearLimit } from "../testing/operation-limits.js";

/**
 * SCIM 2.0 Users and tokens (KOBE-631, spec sso-oidc-scim §10, SSO5/SSO8/SSO9/SSO10): tokens from
 * the Site console (hashed, shown once, rotate, revoke), the `/v1/scim/v2/<slug>` endpoints with
 * Microsoft Entra's request sequence and quirks, deactivation through the console's path, the
 * site-role guard, the kill switch, and the per-provider token boundary.
 */
export const SCIM = "/v1/scim/v2";
export const SCIM_TYPE = "application/scim+json";
export const TENANT_A = "11111111-2222-4333-8444-555555555555";
export const TENANT_B = "99999999-2222-4333-8444-555555555555";
export const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

export let h: Harness;
export let owner: TestBrowser;
export let member: TestBrowser;
export let ownerId = "";
export let adminId = "";
export let localId = "";
export const providers: Record<string, string> = {};
export const tokens: Record<string, string> = {};

export interface ScimRes {
  status: number;
  json: any;
  headers: Headers;
}

export async function scim(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ScimRes> {
  const res = await h.app.request(`${PUBLIC_URL}${SCIM}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": SCIM_TYPE } : {}),
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function addProvider(slug: string, tenantId: string, enabled = true): Promise<string> {
  const [row] = await h.deps.database.db
    .insert(ssoProviders)
    .values({
      slug,
      displayName: slug,
      kind: "entra",
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      tenantId,
      clientId: `${slug}-app`,
      clientSecretSealed: "e1.test-only-not-a-real-envelope",
      clientSecretKeyId: "k1",
      subjectClaim: "oid",
      accessClaim: "roles",
      enabled,
    })
    .returning({ id: ssoProviders.id });
  if (!row) throw new Error("provider insert returned no row");
  return row.id;
}

export async function newToken(slug: string): Promise<{ token: string; id: string }> {
  const res = await owner.post(`/v1/site/sso/providers/${providers[slug]}/scim/tokens`);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { token: res.json.token, id: res.json.credential.id };
}

export async function auditRows(action: string): Promise<any[]> {
  const r = await h.admin.query(
    "SELECT actor_kind, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq",
    [action],
  );
  return r.rows;
}

/** A sign-in session for `userId`; with `providerId`, one made through that provider's SSO. */
export async function sessionFor(userId: string, providerId?: string): Promise<string> {
  const [s] = await h.deps.database.db
    .insert(sessions)
    .values({
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: sessions.id });
  if (!s) throw new Error("session insert returned no row");
  if (providerId) {
    await h.deps.database.db
      .insert(sessionSsoContexts)
      .values({ sessionId: s.id, providerId, mfaSatisfied: true });
  }
  return s.id;
}

export async function sessionExists(id: string): Promise<boolean> {
  const r = await h.admin.query("SELECT 1 FROM sessions WHERE id = $1", [id]);
  return r.rowCount === 1;
}

export const validatorUser = (suffix: string, objectId = randomUUID()) => ({
  schemas: [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  ],
  externalId: objectId,
  userName: `Test_User_${suffix}`,
  active: true,
  emails: [{ primary: true, type: "work", value: `Test_User_${suffix}@testuser.com` }],
  meta: { resourceType: "User" },
  name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
  roles: [],
});

/** Registers the shared hooks; call once at the top level of each scim.*.db.test.ts file. */
export function useScimHarness(): void {
  beforeAll(async () => {
    h = await openHarness({ sso: { settings: loadSsoSettings({ KAIJU_SSO_ENABLED: "true" }) } });
    ownerId = await h.createUser("owner@scim.test", "owner");
    adminId = await h.createUser("admin@scim.test", "admin");
    localId = await h.createUser("local@scim.test");
    owner = await h.signIn("owner@scim.test");
    member = await h.signIn("local@scim.test");
    providers.contoso = await addProvider("contoso", TENANT_A);
    providers.fabrikam = await addProvider("fabrikam", TENANT_B);
    providers.dormant = await addProvider("dormant", TENANT_B, false);
    tokens.contoso = (await newToken("contoso")).token;
    tokens.fabrikam = (await newToken("fabrikam")).token;
    tokens.dormant = (await newToken("dormant")).token;
  });

  afterAll(async () => {
    await h?.close();
  });

  // This file creates more SCIM tokens than one admin may in an hour (KOBE-813): start each test
  // with a fresh allowance.
  afterEach(async () => {
    await clearLimit(h.admin, OPERATION_LIMITS.scimTokenCreate, ownerId);
  });
}
