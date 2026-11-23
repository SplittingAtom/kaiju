import { describe, expect, it } from "vitest";
import {
  ENTRA,
  h,
  entra,
  kc,
  ownerId,
  corpId,
  teamId,
  startAt,
  finish,
  signInVia,
  errorOf,
  entraUser,
  userCount,
  failures,
  useSsoSignInHarness,
} from "./sso-sign-in.test-helpers.js";

useSsoSignInHarness();

describe("sign-in page data", () => {
  it("lists the enabled providers by slug and name only", async () => {
    const res = await h.browser().get("/api/auth/sso/providers");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      providers: [
        { slug: "corp", displayName: "Contoso" },
        { slug: "kc", displayName: "Keycloak" },
      ],
      ssoRequired: false,
    });
  });

  it("sends the browser to the IdP with code + PKCE S256, state and nonce", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const url = new URL(flow.startLocation);
    expect(url.origin + url.pathname).toBe(`${ENTRA.replace(/\/v2\.0$/, "")}/v2.0/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get("redirect_uri")).toBe("http://kobe.test/api/auth/sso/callback/corp");
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("prompt")).toBe("select_account");
    // KOBE-775: a sign-in older than 10 minutes is refused, so the IdP is asked for a fresh one
    // (with a minute of margin for the time spent at the provider).
    expect(p.get("max_age")).toBe("540");
    // The Entra preset asks for the MFA authentication context c1 (§8, KOBE-629).
    expect(JSON.parse(p.get("claims") ?? "null")).toEqual({
      id_token: { acrs: { essential: true, value: "c1" } },
    });
    // The cookie carries no readable verifier, nonce or state.
    expect(flow.flowCookie).not.toContain(p.get("state") ?? "-");
    expect(flow.flowCookie).not.toContain(p.get("nonce") ?? "-");
  });

  it("KOBE-775: asks a generic provider for an authentication at most 10 minutes old", async () => {
    const flow = await startAt(kc, "kc", { sub: "kc-max-age" });
    const p = new URL(flow.startLocation).searchParams;
    expect(p.get("max_age")).toBe("540");
    expect(p.get("prompt")).toBeNull();
  });
});

describe("JIT and linked sign-in", () => {
  it("creates a user for a mapped identity, signs them in and records the SSO context", async () => {
    const user = entraUser();
    const { location, browser } = await signInVia(entra, "corp", user, "/chat?x=1");
    expect(location).toBe("http://kobe.test/chat?x=1");
    const me = await browser.get("/v1/me");
    expect(me.status, me.text).toBe(200);
    expect(me.json.user.email).toBe(String(user.preferred_username));
    const userId = me.json.user.id as string;
    const link = await h.admin.query(
      `SELECT subject, linked_via, email_at_link FROM sso_identities WHERE user_id = $1`,
      [userId],
    );
    expect(link.rows).toEqual([
      { subject: user.oid, linked_via: "jit", email_at_link: user.preferred_username },
    ]);
    const member = await h.admin.query(
      `SELECT role, added_via FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
    expect(member.rows).toEqual([{ role: "member", added_via: `idp:${corpId}` }]);
    const ctx = await h.admin.query(
      `SELECT c.provider_id, c.mfa_satisfied, c.amr, c.acr, c.auth_time
         FROM session_sso_contexts c JOIN sessions s ON s.id = c.session_id WHERE s.user_id = $1`,
      [userId],
    );
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0]).toMatchObject({
      provider_id: corpId,
      // amr "mfa" is in the Entra preset's amr_any (KOBE-629).
      mfa_satisfied: true,
      amr: ["pwd", "mfa"],
      acr: "1",
    });
    expect(new Date(ctx.rows[0].auth_time).getTime()).toBe(Number(user.auth_time) * 1000);
    const { rows: audit } = await h.admin.query<{ action: string; target: unknown }>(
      `SELECT action, target FROM audit_log WHERE actor_id = $1 ORDER BY seq`,
      [userId],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["identity.sso.link.created", "auth.sign_in.succeeded"]),
    );
    expect(audit.find((a) => a.action === "auth.sign_in.succeeded")?.target).toEqual({
      method: "sso",
      mfa: "amr:mfa",
    });
    // No claim or token content in the audit log.
    expect(JSON.stringify(audit)).not.toContain("Ada Lovelace");
  });

  it("signs a linked identity in again without a second user, and keys on oid not email", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const before = await userCount();
    const again = await signInVia(entra, "corp", {
      ...user,
      preferred_username: "new@contoso.com",
    });
    expect(again.location).toBe("http://kobe.test/");
    expect(await userCount()).toBe(before);
    expect((await again.browser.get("/v1/me")).json.user.email).toBe(user.preferred_username);
  });

  it("KOBE-812: an SSO sign-in clears the account's sign-in throttle", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const email = String(user.preferred_username);
    let ip = 0;
    const guess = () =>
      h
        .browser()
        .request(
          "POST",
          "/api/auth/sign-in/email",
          { email, password: "not the password at all" },
          { "x-forwarded-for": `198.19.7.${ip++}` },
        );
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(429);
    await signInVia(entra, "corp", user);
    expect((await guess()).status).toBe(401);
  });

  it("KOBE-775: a first sign-in racing another of the same identity continues as linked", async () => {
    const user = entraUser();
    const email = String(user.preferred_username);
    // The other sign-in's JIT transaction: user and identity written, not yet committed.
    await h.admin.query("BEGIN");
    let committed = false;
    try {
      const { rows } = await h.admin.query<{ id: string }>(
        `INSERT INTO users (email, name, email_verified) VALUES ($1, 'Ada', false) RETURNING id`,
        [email],
      );
      const otherId = rows[0]?.id ?? "";
      await h.admin.query(
        `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via, email_at_link)
         VALUES ($1, $2, $3, 'jit', $4)`,
        [corpId, user.oid, otherId, email],
      );
      const flow = await startAt(entra, "corp", user);
      const pending = finish(flow);
      // This sign-in's own user insert waits on the address's unique index.
      for (let i = 0; i < 200; i++) {
        // Inside a transaction the activity view is a snapshot: refresh it on every look.
        await h.admin.query("SELECT pg_stat_clear_snapshot()");
        const waiting = await h.admin.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
             AND query ILIKE 'insert into "users"%'`,
        );
        if (waiting.rowCount) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await h.admin.query("COMMIT");
      committed = true;
      const { location } = await pending;
      expect(errorOf(location)).toBeNull();
      const me = await flow.browser.get("/v1/me");
      expect(me.status).toBe(200);
      expect(me.json.user.id).toBe(otherId);
    } finally {
      if (!committed) await h.admin.query("ROLLBACK");
    }
  });

  it("gives an unmapped identity no user (no_access)", async () => {
    const before = await userCount();
    const { location, browser } = await signInVia(entra, "corp", entraUser({ roles: ["other"] }));
    expect(errorOf(location)).toBe("not_allowed");
    expect(new URL(location).pathname).toBe("/sign-in");
    expect(await userCount()).toBe(before);
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect((await failures("no_access")).length).toBeGreaterThan(0);
  });

  it("refuses a linked person whose mapping no longer matches and who has no other access", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const { location, browser } = await signInVia(entra, "corp", { ...user, roles: [] });
    expect(errorOf(location)).toBe("not_allowed");
    expect((await browser.get("/v1/me")).status).toBe(401);
  });

  it("refuses a deactivated user", async () => {
    const user = entraUser();
    const first = await signInVia(entra, "corp", user);
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    // Marked directly (no session cleanup), so only "no new session" is under test here.
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [userId]);
    const count = async () =>
      (await h.admin.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId])).rows.length;
    const before = await count();
    const { location, browser } = await signInVia(entra, "corp", user);
    expect(errorOf(location)).toBe("deactivated");
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect(await count()).toBe(before);
  });

  it("never links an identity to a local user with the same email (link_required)", async () => {
    const localId = await h.createUser("grace@contoso.com");
    const before = await userCount();
    const { location, browser } = await signInVia(
      entra,
      "corp",
      entraUser({
        preferred_username: "Grace@Contoso.com",
        email: "grace@contoso.com",
        xms_edov: true,
      }),
    );
    expect(errorOf(location)).toBe("not_allowed");
    expect(await userCount()).toBe(before);
    expect((await browser.get("/v1/me")).status).toBe(401);
    const links = await h.admin.query(`SELECT 1 FROM sso_identities WHERE user_id = $1`, [localId]);
    expect(links.rows).toHaveLength(0);
    const sessions = await h.admin.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [localId]);
    expect(sessions.rows).toHaveLength(0);
    expect((await failures("link_required")).some((f) => f.target.userId === localId)).toBe(true);
  });

  it("replaces the browser's previous session (new session id at every sign-in)", async () => {
    const b = await h.signIn("owner@sso-signin.test");
    const { rows: before } = await h.admin.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1`,
      [ownerId],
    );
    const user = entraUser();
    const flow = await startAt(entra, "corp", user, undefined, b);
    await finish(flow);
    const { rows: after } = await h.admin.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1`,
      [ownerId],
    );
    expect(after.length).toBe(before.length - 1);
    expect((await b.get("/v1/me")).json.user.email).toBe(user.preferred_username);
  });

  it("sends no password-reset link to a user made by SSO (no local credential)", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const sent = h.mailer.sent.length;
    const res = await h.browser().post("/api/auth/request-password-reset", {
      email: user.preferred_username,
      redirectTo: "/reset-password",
    });
    expect(res.status).toBe(200);
    await h.deps.background.idle();
    expect(h.mailer.sent.length).toBe(sent);
  });
});
