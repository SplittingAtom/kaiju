import { describe, expect, it } from "vitest";
import { PASSWORD } from "../testing/harness.js";
import { totpFromUri } from "../testing/totp.js";
import {
  h,
  entra,
  kc,
  corpId,
  nextOid,
  oid,
  signInVia,
  errorOf,
  entraUser,
  userCount,
  useSsoSignInHarness,
} from "./sso-sign-in.test-helpers.js";

useSsoSignInHarness();

describe("site requires 2FA: trust the IdP's MFA (KOBE-629, SSO3, SSO7)", () => {
  const requireTwoFactor = async (on: boolean) => {
    await (on
      ? h.admin.query(
          `INSERT INTO site_settings (key, value) VALUES ('require_2fa', 'true')
           ON CONFLICT (key) DO UPDATE SET value = 'true'`,
        )
      : h.admin.query(`DELETE FROM site_settings WHERE key = 'require_2fa'`));
  };
  const contextOf = async (userId: string) =>
    (
      await h.admin.query<{ mfa_satisfied: boolean }>(
        `SELECT c.mfa_satisfied FROM session_sso_contexts c
           JOIN sessions s ON s.id = c.session_id WHERE s.user_id = $1`,
        [userId],
      )
    ).rows;

  it("ac-1: an MFA-proving sign-in (Entra acrs c1) passes require_2fa without Kobe TOTP", async () => {
    await requireTwoFactor(true);
    try {
      const { location, browser } = await signInVia(
        entra,
        "corp",
        entraUser({ amr: ["pwd"], acrs: ["c1"] }),
      );
      expect(errorOf(location)).toBeNull();
      const me = await browser.get("/v1/me");
      expect(me.status, me.text).toBe(200);
      expect(me.json.user.twoFactorEnabled).toBe(false);
      expect(await contextOf(me.json.user.id as string)).toEqual([{ mfa_satisfied: true }]);
      const { rows } = await h.admin.query(
        `SELECT target FROM audit_log WHERE action = 'auth.sign_in.succeeded' AND actor_id = $1`,
        [me.json.user.id],
      );
      expect(rows).toEqual([{ target: { method: "sso", mfa: "acrs:c1" } }]);
    } finally {
      await requireTwoFactor(false);
    }
  });

  it("ac-1: an amr value in the rule proves MFA too (generic provider)", async () => {
    await requireTwoFactor(true);
    try {
      const { location, browser } = await signInVia(kc, "kc", {
        sub: `kc-mfa-${oid()}`,
        email: `kc-mfa-${nextOid}@kc.example.com`,
        email_verified: true,
        groups: ["g-research"],
        amr: ["pwd", "otp"],
      });
      expect(errorOf(location)).toBeNull();
      expect((await browser.get("/v1/me")).status).toBe(200);
    } finally {
      await requireTwoFactor(false);
    }
  });

  it("ac-2: a non-proving sign-in is refused with mfa_missing: no user, no session", async () => {
    await requireTwoFactor(true);
    try {
      const before = await userCount();
      const sessionsBefore = (await h.admin.query(`SELECT 1 FROM session_sso_contexts`)).rowCount;
      // acrs for another context, or c1 sent to a generic provider, prove nothing.
      for (const [mock, slug, user] of [
        [entra, "corp", entraUser({ amr: ["pwd"], acr: "1" })],
        [entra, "corp", entraUser({ amr: ["pwd"], acrs: ["c2"] })],
        [
          kc,
          "kc",
          { sub: `kc-nomfa-${oid()}`, groups: ["g-research"], amr: ["pwd"], acrs: ["c1"] },
        ],
      ] as const) {
        const { location, browser } = await signInVia(mock, slug, user);
        expect(errorOf(location)).toBe("mfa_missing");
        expect((await browser.get("/v1/me")).status).toBe(401);
      }
      expect(await userCount()).toBe(before);
      expect((await h.admin.query(`SELECT 1 FROM session_sso_contexts`)).rowCount).toBe(
        sessionsBefore,
      );
    } finally {
      await requireTwoFactor(false);
    }
  });

  it("a non-proving sign-in is allowed while 2FA is not required, recorded as not satisfied", async () => {
    const { location, browser } = await signInVia(entra, "corp", entraUser({ amr: ["pwd"] }));
    expect(errorOf(location)).toBeNull();
    const me = await browser.get("/v1/me");
    expect(me.status).toBe(200);
    expect(await contextOf(me.json.user.id as string)).toEqual([{ mfa_satisfied: false }]);
    // Turning require_2fa on later stops that session with the Conditional Access message,
    // not the TOTP enrolment prompt (SSO7: no TOTP fallback).
    await requireTwoFactor(true);
    try {
      const refused = await browser.get("/v1/me");
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe("mfa_missing");
      expect(refused.json.message).toMatch(/Conditional Access/);
    } finally {
      await requireTwoFactor(false);
    }
  });

  it("ac-3: a linked local user's non-MFA SSO session cannot enrol TOTP or backup codes", async () => {
    const localId = await h.createUser("linked-local@sso-signin.test");
    const subject = oid();
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via)
       VALUES ($1, $2, $3, 'admin_expected')`,
      [corpId, subject, localId],
    );
    const user = entraUser({ oid: subject, amr: ["pwd"] });
    const { location, browser } = await signInVia(entra, "corp", user);
    expect(errorOf(location)).toBeNull();
    expect((await browser.get("/v1/me")).json.user.id).toBe(localId);
    for (const [path, body] of [
      ["/api/auth/two-factor/enable", { password: PASSWORD }],
      ["/api/auth/two-factor/get-totp-uri", { password: PASSWORD }],
      ["/api/auth/two-factor/verify-totp", { code: "123456" }],
      ["/api/auth/two-factor/generate-backup-codes", { password: PASSWORD }],
      // Review M1: a passkey (or a new password) is a credential too.
      ["/api/auth/passkey/verify-registration", { response: {} }],
      ["/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "x".repeat(20) }],
    ] as const) {
      const res = await browser.post(path, body);
      expect(res.status, `${path}: ${res.text}`).toBe(403);
      expect(res.json.code).toBe("SSO_MFA_REQUIRED");
    }
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status, options.text).toBe(403);
    expect(options.json.code).toBe("SSO_MFA_REQUIRED");
    const { rows } = await h.admin.query(
      `SELECT u.two_factor_enabled, (SELECT count(*)::int FROM two_factors t WHERE t.user_id = u.id) AS secrets
         FROM users u WHERE u.id = $1`,
      [localId],
    );
    expect(rows[0]).toEqual({ two_factor_enabled: false, secrets: 0 });
    const pk = await h.admin.query(`SELECT 1 FROM passkeys WHERE user_id = $1`, [localId]);
    expect(pk.rowCount).toBe(0);

    // The same person with an MFA-proving SSO session, or a local session, may enrol.
    const mfa = await signInVia(entra, "corp", { ...user, amr: ["pwd", "mfa"] });
    expect(errorOf(mfa.location)).toBeNull();
    const enable = await mfa.browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status, enable.text).toBe(200);
    const pkOptions = await mfa.browser.get("/api/auth/passkey/generate-register-options");
    expect(pkOptions.status, pkOptions.text).toBe(200);
  });

  /** A local user linked to an Entra identity (SSO-5 links; here an admin-expected row). */
  async function linkedLocal(label: string) {
    const email = `${label}-${oid()}@sso-signin.test`;
    const userId = await h.createUser(email);
    const subject = oid();
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via)
       VALUES ($1, $2, $3, 'admin_expected')`,
      [corpId, subject, userId],
    );
    return { email, userId, subject };
  }

  it("review L4: a pending TOTP secret from a local session can't be confirmed from a non-MFA SSO session", async () => {
    const who = await linkedLocal("pending");
    const local = await h.signIn(who.email);
    const enable = await local.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status, enable.text).toBe(200);
    const uri = enable.json.totpURI as string;
    const { browser } = await signInVia(
      entra,
      "corp",
      entraUser({ oid: who.subject, amr: ["pwd"] }),
    );
    const verify = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(uri),
    });
    expect(verify.status, verify.text).toBe(403);
    expect(verify.json.code).toBe("SSO_MFA_REQUIRED");
    const { rows } = await h.admin.query(`SELECT two_factor_enabled FROM users WHERE id = $1`, [
      who.userId,
    ]);
    expect(rows[0]).toEqual({ two_factor_enabled: false });
  });

  it("review L4: a linked user's enrolled TOTP does not stand in for a non-MFA SSO session", async () => {
    const who = await linkedLocal("withtotp");
    const local = await h.signIn(who.email);
    const enable = await local.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const uri = enable.json.totpURI as string;
    const confirm = await local.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(uri),
    });
    expect(confirm.status, confirm.text).toBe(200);
    const { browser } = await signInVia(
      entra,
      "corp",
      entraUser({ oid: who.subject, amr: ["pwd"] }),
    );
    expect((await browser.get("/v1/me")).status).toBe(200);
    await requireTwoFactor(true);
    try {
      const refused = await browser.get("/v1/me");
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe("mfa_missing");
    } finally {
      await requireTwoFactor(false);
    }
  });

  it("review M1: turning require_2fa on ends SSO sessions without MFA proof; others stay", async () => {
    const weak = await signInVia(entra, "corp", entraUser({ amr: ["pwd"] }));
    const strong = await signInVia(entra, "corp", entraUser({ amr: ["pwd"], acrs: ["c1"] }));
    expect((await weak.browser.get("/v1/me")).status).toBe(200);
    const admin = await h.signIn("owner@sso-signin.test");
    try {
      const res = await admin.put("/v1/site/settings", { requireTwoFactor: true });
      expect(res.status, res.text).toBe(200);
      expect((await weak.browser.get("/v1/me")).status).toBe(401);
      expect((await strong.browser.get("/v1/me")).status).toBe(200);
    } finally {
      await requireTwoFactor(false);
    }
    expect((await admin.get("/v1/me")).status).toBe(200);
  });

  it("review L4: break-glass local admin password + TOTP works with require_2fa on and SSO enabled", async () => {
    const email = `breakglass-${oid()}@sso-signin.test`;
    await h.createUser(email, "admin");
    const b = await h.signIn(email);
    const enable = await b.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const uri = enable.json.totpURI as string;
    expect(
      (await b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) })).status,
    ).toBe(200);
    await requireTwoFactor(true);
    try {
      const fresh = h.browser();
      const first = await fresh.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(first.status, first.text).toBe(200);
      const second = await fresh.post("/api/auth/two-factor/verify-totp", {
        code: totpFromUri(uri),
      });
      expect(second.status, second.text).toBe(200);
      expect((await fresh.get("/v1/me")).status).toBe(200);
      expect((await fresh.get("/v1/site/settings")).status).toBe(200);
    } finally {
      await requireTwoFactor(false);
    }
  });
});
