import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { endSsoSessionsWhenOff, seedHelmProviders } from "./providers.js";
import { resolver } from "./testing.js";
import { TestBrowser } from "../testing/browser.js";
import { openHarness, PASSWORD, PUBLIC_URL } from "../testing/harness.js";
import { routeMockOidc } from "../testing/mock-oidc.js";
import { SoftwareAuthenticator } from "../testing/webauthn.js";
import {
  settingsFor,
  h,
  entra,
  kc,
  ownerId,
  corpId,
  startAt,
  finish,
  signInVia,
  errorOf,
  entraUser,
  failures,
  useSsoSignInHarness,
} from "./sso-sign-in.test-helpers.js";

useSsoSignInHarness();

// The break-glass test relies on the IdP's discovery document being cached ("discovery is
// cached"); in the single file earlier describes had fetched it, so this file fetches it once.
beforeAll(async () => {
  await startAt(entra, "corp", entraUser());
});

// First in this file: the sign-in attempt log records one failure per (action, method, account)
// and 5-minute window, so this test's no_access row must open its window before break-glass's
// idp_unreachable (also with no account) does. In the single file earlier describes had left one.
describe("one browser code for no access and an existing account (review finding 9b)", () => {
  it("answers not_allowed for both and keeps the reason in the audit log", async () => {
    await h.createUser("exists-9b@contoso.com");
    const linked = await signInVia(
      entra,
      "corp",
      entraUser({ preferred_username: "exists-9b@contoso.com" }),
    );
    const none = await signInVia(entra, "corp", entraUser({ roles: ["nothing"] }));
    expect(errorOf(linked.location)).toBe("not_allowed");
    expect(errorOf(none.location)).toBe("not_allowed");
    expect(linked.location).toBe(none.location);
    expect((await failures("link_required")).length).toBeGreaterThan(0);
    expect((await failures("no_access")).length).toBeGreaterThan(0);
  });
});

describe("break-glass (SSO10): local sign-in never contacts the IdP", () => {
  it("signs the setup Owner in with a password and a passkey while the IdP is down", async () => {
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const ownerB = await h.signIn("owner@sso-signin.test");
    const options = await ownerB.get("/api/auth/passkey/generate-register-options");
    const registered = await ownerB.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "break-glass key",
    });
    expect(registered.status, registered.text).toBe(200);
    await h.createUser("local@sso-signin.test");

    entra.down = true;
    kc.down = true;
    const hits = entra.hits.length + kc.hits.length;
    try {
      const pw = h.browser();
      const res = await pw.post("/api/auth/sign-in/email", {
        email: "owner@sso-signin.test",
        password: PASSWORD,
      });
      expect(res.status, res.text).toBe(200);
      expect((await pw.get("/v1/me")).json.user.id).toBe(ownerId);

      const pk = h.browser();
      const authOptions = await pk.get("/api/auth/passkey/generate-authenticate-options");
      const verified = await pk.post("/api/auth/passkey/verify-authentication", {
        response: authenticator.authenticate(authOptions.json),
      });
      expect(verified.status, verified.text).toBe(200);
      expect((await pk.get("/v1/me")).json.user.id).toBe(ownerId);

      const local = await h.signIn("local@sso-signin.test");
      expect((await local.get("/v1/me")).status).toBe(200);
      expect(entra.hits.length + kc.hits.length).toBe(hits);

      // SSO itself reports the outage plainly (discovery is cached; the token endpoint is not).
      const flow = await startAt(entra, "corp", entraUser());
      expect(errorOf((await finish(flow)).location)).toBe("idp_unreachable");
    } finally {
      entra.down = false;
      kc.down = false;
    }
  });
});

describe("rate limits", () => {
  it("allows 20 starts per minute per address", async () => {
    const b = h.browser();
    for (let i = 0; i < 20; i++) {
      expect((await b.get("/api/auth/sso/start/corp")).status).toBe(302);
    }
    expect((await b.get("/api/auth/sso/start/corp")).status).toBe(429);
  });
});

describe("kill switch (auth.sso.enabled: false)", () => {
  it("answers 404 on every SSO route", async () => {
    const off = await openHarness({
      sso: {
        settings: settingsFor("false"),
        net: { resolve: resolver() },
        request: routeMockOidc(entra, kc),
      },
    });
    try {
      await seedHelmProviders(off.deps.database.db, settingsFor("false"));
      const b = off.browser();
      expect((await b.get("/api/auth/sso/providers")).status).toBe(404);
      expect((await b.get("/api/auth/sso/start/corp")).status).toBe(404);
      expect((await b.get("/api/auth/sso/callback/corp?code=x&state=y")).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("max_session_hours (review finding 9a)", () => {
  it("caps the SSO session's expiry and ends it once the hours have passed", async () => {
    await h.admin.query(`UPDATE sso_providers SET max_session_hours = 1 WHERE id = $1`, [corpId]);
    try {
      const user = entraUser();
      const { browser } = await signInVia(entra, "corp", user);
      // Read before any request: Better Auth's refresh may push expires_at forward on use.
      const { rows } = await h.admin.query<{ id: string; left: number }>(
        `SELECT s.id, extract(epoch FROM s.expires_at - now())::int AS left
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id
          WHERE i.subject = $1`,
        [user.oid],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.left).toBeLessThanOrEqual(3600);
      expect((await browser.get("/v1/me")).status).toBe(200);
      // The cap counts from the session's start, whatever a refresh did to expires_at.
      await h.admin.query(
        `UPDATE sessions SET created_at = now() - interval '61 minutes',
                             expires_at = now() + interval '1 day' WHERE id = $1`,
        [rows[0]?.id],
      );
      expect((await browser.get("/v1/me")).status).toBe(401);
      const gone = await h.admin.query(`SELECT 1 FROM sessions WHERE id = $1`, [rows[0]?.id]);
      expect(gone.rowCount).toBe(0);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET max_session_hours = NULL WHERE id = $1`, [
        corpId,
      ]);
    }
  });
});

describe("max_session_hours against Better Auth's refresh (re-review A)", () => {
  it("never lets a refresh push an SSO session past created_at + max hours", async () => {
    await h.admin.query(`UPDATE sso_providers SET max_session_hours = 1 WHERE id = $1`, [corpId]);
    try {
      const user = entraUser();
      const { browser } = await signInVia(entra, "corp", user);
      // A capped session is "due" for Better Auth's refresh at once: get-session refreshes it.
      const got = await browser.get("/api/auth/get-session");
      expect(got.status, got.text).toBe(200);
      const over = await h.admin.query<{ over: boolean }>(
        `SELECT s.expires_at > s.created_at + interval '1 hour' AS over
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id WHERE i.subject = $1`,
        [user.oid],
      );
      expect(over.rows).toEqual([{ over: false }]);
      // Any later update of the expiry is capped as well.
      await h.admin.query(
        `UPDATE sessions s SET expires_at = now() + interval '30 days'
           FROM sso_identities i WHERE i.user_id = s.user_id AND i.subject = $1`,
        [user.oid],
      );
      const again = await h.admin.query<{ over: boolean }>(
        `SELECT s.expires_at > s.created_at + interval '1 hour' AS over
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id WHERE i.subject = $1`,
        [user.oid],
      );
      expect(again.rows).toEqual([{ over: false }]);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET max_session_hours = NULL WHERE id = $1`, [
        corpId,
      ]);
    }
  });
});

describe("a session made while its provider was turned off or unlinked (KOBE-775)", () => {
  const sessionIdOf = async (userId: string) =>
    (
      await h.admin.query<{ id: string }>(
        `SELECT s.id FROM sessions s JOIN session_sso_contexts c ON c.session_id = s.id
          WHERE s.user_id = $1`,
        [userId],
      )
    ).rows.map((r) => r.id);

  it("ends an SSO session whose provider is off at the next request", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    const me = await browser.get("/v1/me");
    expect(me.status).toBe(200);
    const userId = me.json.user.id as string;
    expect(await sessionIdOf(userId)).toHaveLength(1);
    // As if the provider was turned off while this sign-in's callback was running: the flag is
    // off, but the session ending already happened before the session existed.
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE id = $1`, [corpId]);
    try {
      expect((await browser.get("/v1/me")).status).toBe(401);
      expect(await sessionIdOf(userId)).toEqual([]);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET enabled = true WHERE id = $1`, [corpId]);
    }
  });

  it("ends an SSO session whose identity link is gone at the next request", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    const me = await browser.get("/v1/me");
    expect(me.status).toBe(200);
    const userId = me.json.user.id as string;
    await h.admin.query(`DELETE FROM sso_identities WHERE provider_id = $1 AND user_id = $2`, [
      corpId,
      userId,
    ]);
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect(await sessionIdOf(userId)).toEqual([]);
  });
});

describe("kill switch and live sessions (review finding 6)", () => {
  it("refuses SSO sessions while auth.sso.enabled is false; local sessions keep working", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    expect((await browser.get("/v1/me")).status).toBe(200);
    const local = await h.signIn("owner@sso-signin.test");
    const offSettings = settingsFor("false");
    const offApp = createApp({ ...h.deps, sso: { ...h.deps.sso, settings: offSettings } });
    const as = (from: TestBrowser) => {
      const b = new TestBrowser(offApp, PUBLIC_URL);
      for (const [k, v] of from.cookies) b.cookies.set(k, v);
      return b;
    };
    expect((await as(browser).get("/v1/me")).status).toBe(401);
    expect((await as(local).get("/v1/me")).status).toBe(200);

    // At start-up with the switch off, every SSO session is deleted; local ones stay.
    const ended = await endSsoSessionsWhenOff(h.deps.database.db, offSettings);
    expect(ended).toBeGreaterThan(0);
    const left = await h.admin.query(`SELECT 1 FROM session_sso_contexts`);
    expect(left.rowCount).toBe(0);
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect((await local.get("/v1/me")).status).toBe(200);
    expect(await endSsoSessionsWhenOff(h.deps.database.db, settingsFor("true"))).toBe(0);
  });
});
