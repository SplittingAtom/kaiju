import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnvelope, type Envelope } from "@kobe/db";
import { seedHelmProviders } from "./sso/providers.js";
import { ssoRequired } from "./sso/required.js";
import { loadSsoSettings, type SsoSettings } from "./sso/settings.js";
import { FakeIdp, resolver } from "./sso/testing.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, type Harness } from "./testing/harness.js";

/**
 * KOBE-774: the Site setting "Require single sign-on". It turns on only from a session signed in
 * through an enabled provider; while on, the server refuses password sign-in, password reset and
 * password sign-up (invitation acceptance) and passkey sign-in, and local sessions end; it turns
 * itself off (audited, site admins emailed) when the last enabled provider goes; the chart's kill
 * switch suspends it.
 */
const SETTINGS = "/v1/site/sso/settings";
const PROVIDERS = "/v1/site/sso/providers";
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const HELM_SECRET = "Helm~Secret.Value-from-the-k8s-Secret";
const SECRET = "Cl1ent~Secret.Value-0123456789abcdef";

const idp = new FakeIdp().discovery(ENTRA, { code_challenge_methods_supported: undefined });

const HELM_PROVIDER = {
  slug: "corp",
  displayName: "Corp Entra",
  kind: "entra",
  tenantId: TENANT,
  clientId: "corp-app",
};
const helmEnv = (providers: unknown[], enabled = "true"): SsoSettings =>
  loadSsoSettings({
    KOBE_SSO_ENABLED: enabled,
    KOBE_SSO_PROVIDERS: JSON.stringify(providers),
    KOBE_SSO_CLIENT_SECRET_CORP: HELM_SECRET,
  });

let h: Harness;
let settings: SsoSettings;
let corpId = "";
let ownerId = "";
let adminId = "";

const ownerEmail = "owner@required.test";
const adminEmail = "admin@required.test";
const memberEmail = "member@required.test";

async function sessionIdsOf(userId: string): Promise<string[]> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map((r) => r.id);
}

/** Signs in with the password, then marks that session as signed in through `providerId`. */
async function ssoBrowser(email: string, userId: string, providerId = corpId) {
  const before = new Set(await sessionIdsOf(userId));
  const browser = await h.signIn(email);
  const id = (await sessionIdsOf(userId)).find((s) => !before.has(s));
  await h.admin.query(
    `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied) VALUES ($1, $2, true)`,
    [id, providerId],
  );
  return browser;
}

/** Links the user to a provider (as a past SSO sign-in would). */
async function linkIdentity(userId: string, providerId = corpId) {
  await h.admin.query(
    `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via)
     VALUES ($1, $2, $3, 'local_proof') ON CONFLICT DO NOTHING`,
    [providerId, `sub-${userId}`, userId],
  );
}

async function setRequired(on: boolean) {
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('require_sso', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(on)],
  );
}

async function storedRequired(): Promise<string | undefined> {
  const { rows } = await h.admin.query<{ value: string }>(
    `SELECT value FROM site_settings WHERE key = 'require_sso'`,
  );
  return rows[0]?.value;
}

async function requiredAudit() {
  const { rows } = await h.admin.query<{
    action: string;
    target: Record<string, unknown>;
    actor_kind: string;
    actor_id: string | null;
  }>(
    `SELECT action, target, actor_kind, actor_id FROM audit_log
      WHERE action LIKE 'identity.sso.required.%' ORDER BY seq`,
  );
  return rows;
}

beforeAll(async () => {
  settings = helmEnv([HELM_PROVIDER]);
  h = await openHarness({
    envelope: loadEnvelope({ KOBE_ENVELOPE_KEY: "s".repeat(48) }) as Envelope,
    sso: { settings, net: { resolve: resolver() }, request: idp.request },
  });
  await seedHelmProviders(h.deps.database.db, settings);
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM sso_providers WHERE slug = 'corp'`,
  );
  corpId = rows[0]?.id ?? "";
  ownerId = await h.createUser(ownerEmail, "owner");
  adminId = await h.createUser(adminEmail, "admin");
  await h.createUser(memberEmail);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await setRequired(false);
  await h.admin.query(`UPDATE sso_providers SET enabled = true WHERE slug = 'corp'`);
  await h.admin.query(`DELETE FROM sessions`);
  await h.admin.query(`DELETE FROM sso_identities`);
  h.mailer.sent.length = 0;
});

describe("turning it on (ac-1)", () => {
  it("is refused from a local session, with a clear error", async () => {
    const admin = await h.signIn(adminEmail);
    expect((await admin.get(SETTINGS)).json).toMatchObject({
      requireSso: false,
      canTurnOn: false,
    });
    const res = await admin.put(SETTINGS, { requireSso: true });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("sso_session_required");
    expect(await storedRequired()).toBe("false");
  });

  it("is refused while the session's provider is disabled", async () => {
    const admin = await ssoBrowser(adminEmail, adminId);
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE slug = 'corp'`);
    const res = await admin.put(SETTINGS, { requireSso: true });
    expect(res.status).toBe(409);
    expect(await storedRequired()).toBe("false");
  });

  it("is site.users.manage only", async () => {
    const member = await h.signIn(memberEmail);
    expect((await member.get(SETTINGS)).status).toBe(403);
    expect((await member.put(SETTINGS, { requireSso: true })).status).toBe(403);
  });

  it("is refused while an active Owner has no identity at an enabled provider (review H1)", async () => {
    const admin = await ssoBrowser(adminEmail, adminId);
    const view = await admin.get(SETTINGS);
    // Counts only: never who.
    expect(view.json.unlinked).toEqual({ owners: 1, siteRoles: 2, users: 3 });
    expect(JSON.stringify(view.json)).not.toContain(ownerEmail);
    const res = await admin.put(SETTINGS, { requireSso: true });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("owners_not_linked");
    expect(res.json.message).toMatch(/1 Owner/);
    expect(res.json.message).not.toContain(ownerEmail);
    expect(await storedRequired()).toBe("false");
    // A link at a disabled provider does not count.
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim,
              access_claim, managed_by, enabled)
       VALUES ('off-${randomUUID().slice(0, 6)}', 'Off', 'oidc', 'https://off.example.com', 'c',
               'sub', 'roles', 'helm', false) RETURNING id`,
    );
    await linkIdentity(ownerId, rows[0]?.id);
    expect((await admin.put(SETTINGS, { requireSso: true })).status).toBe(409);
    // Linked at an enabled provider: it turns on.
    await linkIdentity(ownerId);
    expect((await admin.get(SETTINGS)).json.unlinked).toMatchObject({ owners: 0, siteRoles: 1 });
    expect((await admin.put(SETTINGS, { requireSso: true })).status).toBe(200);
  });

  it("from an SSO session: on, audited, and every local session ends", async () => {
    await linkIdentity(ownerId);
    const member = await h.signIn(memberEmail);
    const localOwner = await h.signIn(ownerEmail);
    const admin = await ssoBrowser(adminEmail, adminId);
    expect((await admin.get(SETTINGS)).json.canTurnOn).toBe(true);
    const res = await admin.put(SETTINGS, { requireSso: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ requireSso: true, inForce: true });
    expect(await storedRequired()).toBe("true");
    expect((await member.get("/v1/me")).status).toBe(401);
    expect((await localOwner.get("/v1/me")).status).toBe(401);
    expect((await admin.get("/v1/me")).status).toBe(200);
    expect((await requiredAudit()).at(-1)).toEqual({
      action: "identity.sso.required.enabled",
      target: { sessionsEnded: 2 },
      actor_kind: "user",
      actor_id: adminId,
    });
  });
});

describe("while it is on (ac-2)", () => {
  beforeEach(async () => {
    await setRequired(true);
  });

  const refused = (res: { status: number; json: { code?: string } }) => {
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("SSO_REQUIRED");
  };

  it("refuses password sign-in, even with the right password", async () => {
    refused(
      await h.browser().post("/api/auth/sign-in/email", { email: memberEmail, password: PASSWORD }),
    );
    expect(await sessionIdsOf(ownerId)).toEqual([]);
  });

  it("refuses password reset requests and resets", async () => {
    refused(
      await h.browser().post("/api/auth/request-password-reset", {
        email: memberEmail,
        redirectTo: "/reset-password",
      }),
    );
    refused(
      await h
        .browser()
        .post("/api/auth/reset-password", { token: "x".repeat(24), newPassword: "n".repeat(16) }),
    );
    await h.deps.background.idle();
    expect(h.mailer.sent).toEqual([]);
  });

  it("refuses password sign-up and invitation acceptance", async () => {
    refused(
      await h.browser().post("/api/auth/sign-up/email", {
        email: "new@required.test",
        password: "n".repeat(16),
        name: "New",
      }),
    );
    refused(
      await h.browser().post("/api/auth/invitation/accept", {
        token: "t".repeat(32),
        name: "New",
        password: "n".repeat(16),
      }),
    );
  });

  it("refuses passkey sign-in", async () => {
    refused(await h.browser().post("/api/auth/passkey/verify-authentication", { response: {} }));
  });

  it("ends a local session at its next check, and keeps SSO sessions", async () => {
    await setRequired(false);
    const local = await h.signIn(memberEmail);
    const sso = await ssoBrowser(adminEmail, adminId);
    await setRequired(true);
    expect((await local.get("/v1/me")).status).toBe(401);
    expect((await sso.get("/v1/me")).status).toBe(200);
    const { rows } = await h.admin.query(
      `SELECT 1 FROM sessions s WHERE NOT EXISTS
         (SELECT 1 FROM session_sso_contexts c WHERE c.session_id = s.id)`,
    );
    expect(rows).toEqual([]);
  });

  it("tells the sign-in page (public providers route)", async () => {
    const res = await h.browser().get("/api/auth/sso/providers");
    expect(res.json).toEqual({
      providers: [{ slug: "corp", displayName: "Corp Entra" }],
      ssoRequired: true,
    });
  });

  it("is suspended by the chart's kill switch and without a usable provider", async () => {
    const db = h.deps.database.db;
    expect(await ssoRequired(db, settings)).toBe(true);
    expect(await ssoRequired(db, { ...settings, enabled: false })).toBe(false);
    // A Helm provider whose Secret is not mounted can't finish a sign-in.
    expect(await ssoRequired(db, { ...settings, helmSecrets: new Map() })).toBe(false);
  });
});

describe("turning it off", () => {
  it("is the Owner's call (it weakens every account)", async () => {
    const admin = await ssoBrowser(adminEmail, adminId);
    const owner = await ssoBrowser(ownerEmail, ownerId);
    await setRequired(true);
    const res = await admin.put(SETTINGS, { requireSso: false });
    expect(res.status).toBe(403);
    expect(await storedRequired()).toBe("true");
    const ok = await owner.put(SETTINGS, { requireSso: false });
    expect(ok.status).toBe(200);
    expect(ok.json.requireSso).toBe(false);
    expect((await requiredAudit()).at(-1)).toMatchObject({
      action: "identity.sso.required.disabled",
      target: { reason: "admin" },
      actor_id: ownerId,
    });
    // Password sign-in works again.
    const back = await h.browser().post("/api/auth/sign-in/email", {
      email: memberEmail,
      password: PASSWORD,
    });
    expect(back.status).toBe(200);
  });
});

describe("the last enabled provider going (ac-5)", () => {
  async function consoleProvider(admin: TestBrowser, slug: string): Promise<string> {
    const res = await admin.post(PROVIDERS, {
      kind: "entra",
      slug,
      displayName: `Console ${slug}`,
      tenantId: TENANT,
      clientId: "11111111-aaaa-4bbb-8ccc-222222222222",
      clientSecret: SECRET,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const id = res.json.provider.id as string;
    expect((await admin.patch(`${PROVIDERS}/${id}`, { enabled: true })).status).toBe(200);
    return id;
  }

  it("disabling it turns the setting off, audited, and emails the site admins", async () => {
    const admin = await h.signIn(adminEmail);
    const id = await consoleProvider(admin, `last-${randomUUID().slice(0, 8)}`);
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE slug = 'corp'`);
    const sso = await ssoBrowser(adminEmail, adminId, id);
    await setRequired(true);
    const res = await sso.patch(`${PROVIDERS}/${id}`, { enabled: false });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await storedRequired()).toBe("false");
    expect((await requiredAudit()).at(-1)).toMatchObject({
      action: "identity.sso.required.disabled",
      // The acting admin is named in the target too (review M2): an Admin can't otherwise stop
      // requiring single sign-on.
      target: { reason: "last_provider", providerId: id, byUserId: adminId },
      actor_id: adminId,
    });
    await h.deps.background.idle();
    const to = h.mailer.sent.map((m) => m.to).sort();
    expect(to).toEqual([adminEmail, ownerEmail].sort());
    expect(h.mailer.sent[0]?.subject).toMatch(/single sign-on is no longer required/i);
  });

  it("deleting it does the same", async () => {
    const admin = await h.signIn(adminEmail);
    const id = await consoleProvider(admin, `del-${randomUUID().slice(0, 8)}`);
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE slug = 'corp'`);
    const sso = await ssoBrowser(adminEmail, adminId, id);
    await setRequired(true);
    const res = await sso.delete(`${PROVIDERS}/${id}`);
    expect(res.status).toBe(204);
    expect(await storedRequired()).toBe("false");
    expect((await requiredAudit()).at(-1)).toMatchObject({
      action: "identity.sso.required.disabled",
      target: { reason: "last_provider", providerId: id },
    });
  });

  it("stays on while another enabled provider remains", async () => {
    const admin = await h.signIn(adminEmail);
    const id = await consoleProvider(admin, `other-${randomUUID().slice(0, 8)}`);
    const sso = await ssoBrowser(adminEmail, adminId);
    await setRequired(true);
    expect((await sso.patch(`${PROVIDERS}/${id}`, { enabled: false })).status).toBe(200);
    expect(await storedRequired()).toBe("true");
  });

  it("the chart dropping or disabling its last provider turns it off at start-up (system)", async () => {
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE managed_by = 'console'`);
    await setRequired(true);
    const result = await seedHelmProviders(
      h.deps.database.db,
      helmEnv([{ ...HELM_PROVIDER, enabled: false }]),
    );
    expect(result.ssoRequiredTurnedOff).toBe(true);
    expect(await storedRequired()).toBe("false");
    expect((await requiredAudit()).at(-1)).toMatchObject({
      action: "identity.sso.required.disabled",
      target: { reason: "last_provider", providerId: corpId, slug: "corp" },
      actor_kind: "system",
    });
  });
});
