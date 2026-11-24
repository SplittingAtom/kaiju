// Shared setup for the sso-sign-in.*.db.test.ts files
// (split from sso-sign-in.db.test.ts, KOBE-725).
import { afterAll, beforeAll, expect } from "vitest";
import { seedHelmProviders } from "./providers.js";
import { loadSsoSettings, type SsoSettings } from "./settings.js";
import { resolver } from "./testing.js";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MockOidcProvider, routeMockOidc } from "../testing/mock-oidc.js";

/**
 * KOBE-628 (spec sso-oidc-scim §5, §6, §9, §13; SSO10): OIDC sign-in end to end against an
 * in-process mock IdP — state/nonce/PKCE, ID token checks, JIT only with mapped access, never
 * linking on email, deactivated users, groups overage, session_sso_contexts, returnTo, the kill
 * switch, rate limits, and local break-glass sign-in with the IdP down.
 */
export const TENANT = "11111111-2222-4333-8444-555555555555";
export const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
export const KC = "https://kc.example.com/realms/kobe";
export const CORP_SECRET = "Corp~Secret.Value-0123456789abcdef";
export const KC_SECRET = "Kc~Secret.Value-0123456789abcdefgh";

export const settingsFor = (enabled: "true" | "false"): SsoSettings =>
  loadSsoSettings({
    KOBE_SSO_ENABLED: enabled,
    KOBE_SSO_PROVIDERS: JSON.stringify([
      {
        slug: "corp",
        displayName: "Contoso",
        kind: "entra",
        tenantId: TENANT,
        clientId: "corp-app",
      },
      {
        slug: "kc",
        displayName: "Keycloak",
        kind: "oidc",
        issuer: KC,
        clientId: "kc-app",
        accessClaim: "groups",
      },
    ]),
    KOBE_SSO_CLIENT_SECRET_CORP: CORP_SECRET,
    KOBE_SSO_CLIENT_SECRET_KC: KC_SECRET,
  });

export let h: Harness;
export let entra: MockOidcProvider;
export let kc: MockOidcProvider;
export let owner: TestBrowser;
export let ownerId = "";
export let corpId = "";
export let kcId = "";
export let teamId = "";
export let nextOid = 1;
export const oid = () => `00000000-0000-4000-8000-${String(nextOid++).padStart(12, "0")}`;

export interface Flow {
  readonly browser: TestBrowser;
  readonly startLocation: string;
  readonly callback: URL;
  readonly flowCookie: string;
}

/** Start in a fresh browser (own IP) and let the person sign in at the IdP. */
export async function startAt(
  mock: MockOidcProvider,
  slug: string,
  user: Record<string, unknown>,
  returnTo?: string,
  browser = h.browser(),
): Promise<Flow> {
  const qs = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const start = await browser.get(`/api/auth/sso/start/${slug}${qs}`);
  expect(start.status, start.text).toBe(302);
  const startLocation = start.headers.get("location") ?? "";
  const flowCookie = browser.cookies.get("kobe-sso") ?? "";
  expect(flowCookie).not.toBe("");
  return { browser, startLocation, callback: mock.authorize(startLocation, user), flowCookie };
}

export async function finish(flow: Flow, callback = flow.callback) {
  const res = await flow.browser.get(`${callback.pathname}${callback.search}`);
  expect(res.status, res.text).toBe(302);
  return { res, location: res.headers.get("location") ?? "" };
}

export async function signInVia(
  mock: MockOidcProvider,
  slug: string,
  user: Record<string, unknown>,
  returnTo?: string,
) {
  const flow = await startAt(mock, slug, user, returnTo);
  return { ...(await finish(flow)), browser: flow.browser, flow };
}

export const errorOf = (location: string) => new URL(location).searchParams.get("sso_error");
export const entraUser = (over: Record<string, unknown> = {}) => {
  const id = oid();
  return {
    oid: id,
    sub: `pairwise-${id}`,
    name: "Ada Lovelace",
    preferred_username: `ada-${id}@contoso.com`,
    roles: ["kobe.research.member"],
    amr: ["pwd", "mfa"],
    acr: "1",
    auth_time: Math.floor(Date.now() / 1000) - 5,
    ...over,
  };
};

export async function userCount(): Promise<number> {
  const { rows } = await h.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  return rows[0]?.n ?? 0;
}

export async function failures(reason: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = 'auth.sign_in.failed'
       AND target ->> 'method' = 'sso' AND target ->> 'reason' = $1`,
    [reason],
  );
  return rows;
}

/** Registers the shared hooks; call once at the top level of each sso-sign-in.*.db.test.ts file. */
export function useSsoSignInHarness(): void {
  beforeAll(async () => {
    entra = await MockOidcProvider.create({
      issuer: ENTRA,
      clientId: "corp-app",
      clientSecret: CORP_SECRET,
      tenantId: TENANT,
      // Entra supports S256 without advertising it; it also lists algorithms Kaiju never accepts.
      discovery: {
        code_challenge_methods_supported: undefined,
        id_token_signing_alg_values_supported: ["RS256", "HS256", "none"],
      },
    });
    kc = await MockOidcProvider.create({
      issuer: KC,
      clientId: "kc-app",
      clientSecret: KC_SECRET,
      algorithm: "ES256",
    });
    const settings = settingsFor("true");
    h = await openHarness({
      sso: { settings, net: { resolve: resolver() }, request: routeMockOidc(entra, kc) },
    });
    await seedHelmProviders(h.deps.database.db, settings);
    ownerId = await h.createUser("owner@sso-signin.test", "owner");
    owner = await h.signIn("owner@sso-signin.test");
    const team = await owner.post("/v1/site/teams", {
      slug: "research",
      name: "Research",
      adminUserId: ownerId,
    });
    expect(team.status, JSON.stringify(team.json)).toBe(201);
    teamId = team.json.team.id;
    const { rows } = await h.admin.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM sso_providers`,
    );
    corpId = rows.find((r) => r.slug === "corp")?.id ?? "";
    kcId = rows.find((r) => r.slug === "kc")?.id ?? "";
    for (const [providerId, claimValue, role] of [
      [corpId, "kobe.research.member", "member"],
      [kcId, "g-research", "contributor"],
    ] as const) {
      const res = await owner.post(`/v1/site/sso/providers/${providerId}/mappings`, {
        claimValue,
        teamId,
        role,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    }
  });

  afterAll(async () => {
    await h?.close();
  });
}
