import { describe, expect, it } from "vitest";
import { SoftwareAuthenticator } from "../testing/webauthn.js";
import {
  h,
  entra,
  kc,
  kcId,
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

describe("team invitations need a verified address (nOAuth, review finding 1)", () => {
  async function invite(email: string, role: "member" | "team_admin" = "team_admin") {
    const admin = await h.signIn("owner@sso-signin.test");
    await admin.put("/v1/me/teams/active", { teamId });
    admin.team = teamId;
    const res = await admin.post("/v1/team/invites", { email, role });
    expect(res.status, res.text).toBeLessThan(300);
  }

  it("Entra: a self-set email claim never becomes the address (the UPN does)", async () => {
    await invite("victim1@kobe-victim.test");
    const { browser } = await signInVia(
      entra,
      "corp",
      entraUser({ email: "victim1@kobe-victim.test", preferred_username: "eve1@contoso.com" }),
    );
    const me = await browser.get("/v1/me");
    expect(me.json.user.email).toBe("eve1@contoso.com");
    expect((await browser.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(404);
  });

  it("generic: an unverified email lists and accepts no invitation", async () => {
    await invite("victim2@kobe-victim.test");
    const { browser } = await signInVia(kc, "kc", {
      sub: "kc-nOAuth-1",
      email: "victim2@kobe-victim.test",
      groups: ["g-research"],
    });
    const me = await browser.get("/v1/me");
    expect(me.status, me.text).toBe(200);
    const userId = me.json.user.id as string;
    const row = await h.admin.query(`SELECT email, email_verified FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(row.rows[0]).toEqual({ email: "victim2@kobe-victim.test", email_verified: false });
    expect((await browser.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(404);
    expect((await browser.post(`/v1/me/invites/${teamId}/decline`)).status).toBe(404);
    const member = await h.admin.query(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
    expect(member.rows).toEqual([{ role: "contributor" }]);
    // The invitation is still there for the real owner of the address.
    const open = await h.admin.query(
      `SELECT 1 FROM team_invitations WHERE email = 'victim2@kobe-victim.test'`,
    );
    expect(open.rowCount).toBe(1);
  });

  it("generic: a verified email (email_verified: true) accepts its invitation", async () => {
    await invite("verified3@kobe-victim.test", "member");
    const { browser } = await signInVia(kc, "kc", {
      sub: "kc-verified-3",
      email: "verified3@kobe-victim.test",
      email_verified: true,
      groups: ["g-research"],
    });
    const list = await browser.get("/v1/me/invites");
    expect(list.json.invitations).toHaveLength(1);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(200);
  });
});

describe("SSO-made users get no local credential (SSO9, review finding 3)", () => {
  it("refuses passkey registration, a password change and TOTP enrolment", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    expect((await browser.get("/v1/me")).status).toBe(200);
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.json.code).toBe("SSO_ONLY_ACCOUNT");
    const verify = await browser.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register({
        challenge: "AAAA",
        rp: { id: "kobe.test", name: "Kaiju" },
        user: { id: "AAAA", name: "x" },
      }),
    });
    expect(verify.status).toBe(403);
    const change = await browser.post("/api/auth/change-password", {
      currentPassword: "x",
      newPassword: "a-new-long-password-123",
    });
    expect(change.status).toBe(403);
    const totp = await browser.post("/api/auth/two-factor/enable", { password: "x" });
    expect(totp.status).toBe(403);
    const userId = (await browser.get("/v1/me")).json.user.id as string;
    const creds = await h.admin.query(
      `SELECT (SELECT count(*)::int FROM passkeys WHERE user_id = $1) AS passkeys,
              (SELECT count(*)::int FROM accounts WHERE user_id = $1) AS accounts`,
      [userId],
    );
    expect(creds.rows[0]).toEqual({ passkeys: 0, accounts: 0 });
  });

  it("still lets a local user add a passkey", async () => {
    await h.createUser("pk-local@sso-signin.test");
    const b = await h.signIn("pk-local@sso-signin.test");
    const options = await b.get("/api/auth/passkey/generate-register-options");
    expect(options.status, options.text).toBe(200);
  });
});

describe("state, nonce and ID token checks (ac-1)", () => {
  it("refuses a tampered state parameter", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const cb = new URL(flow.callback);
    cb.searchParams.set("state", `${cb.searchParams.get("state")}x`);
    expect(errorOf((await finish(flow, cb)).location)).toBe("state_invalid");
  });

  it("refuses a tampered flow cookie", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const raw = Buffer.from(flow.flowCookie, "base64url");
    raw[raw.length - 2] = (raw[raw.length - 2] ?? 0) ^ 1;
    flow.browser.cookies.set("kobe-sso", raw.toString("base64url"));
    expect(errorOf((await finish(flow)).location)).toBe("state_invalid");
  });

  it("refuses a callback in a browser that did not start the flow (login CSRF)", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const other = h.browser();
    const res = await other.get(`${flow.callback.pathname}${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
  });

  it("refuses a replayed callback with its cookie (single use)", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    expect(errorOf((await finish(flow)).location)).toBeNull();
    const replay = h.browser();
    replay.cookies.set("kobe-sso", flow.flowCookie);
    const res = await replay.get(`${flow.callback.pathname}${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
    expect((await replay.get("/v1/me")).status).toBe(401);
  });

  it("refuses a flow cookie used on another provider's callback", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const res = await flow.browser.get(`/api/auth/sso/callback/kc${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
  });

  it.each([
    ["a wrong nonce", { nonce: "not-the-nonce" }, ["token_invalid"]],
    ["a wrong audience", { aud: "someone-else" }, ["token_invalid"]],
    [
      "a wrong issuer",
      { iss: "https://login.microsoftonline.com/common/v2.0" },
      ["token_invalid", "tenant_mismatch"],
    ],
    ["a wrong tenant", { tid: "99999999-2222-4333-8444-555555555555" }, ["tenant_mismatch"]],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, ["token_invalid"]],
    ["a stale auth_time", { auth_time: Math.floor(Date.now() / 1000) - 3600 }, ["token_invalid"]],
  ])("refuses %s", async (_what, overrides, codes) => {
    const before = await userCount();
    entra.overrides = overrides;
    try {
      const { location, browser } = await signInVia(entra, "corp", entraUser());
      expect(codes).toContain(errorOf(location));
      expect((await browser.get("/v1/me")).status).toBe(401);
    } finally {
      entra.overrides = {};
    }
    expect(await userCount()).toBe(before);
  });

  it.each(["alg_none", "hs256_client_secret", "foreign_key"] as const)(
    "refuses an ID token in mode %s (even though discovery lists none/HS256)",
    async (mode) => {
      const before = await userCount();
      entra.mode = mode;
      try {
        const { location, browser } = await signInVia(entra, "corp", entraUser());
        expect(errorOf(location)).toBe("token_invalid");
        expect((await browser.get("/v1/me")).status).toBe(401);
      } finally {
        entra.mode = "ok";
      }
      expect(await userCount()).toBe(before);
    },
  );

  it("KOBE-775: refuses a generic provider's ID token without auth_time", async () => {
    const flow = await startAt(kc, "kc", {
      sub: "kc-no-auth-time",
      email: "kc-nat@example.com",
      groups: ["g-research"],
      auth_time: undefined,
    });
    const { location } = await finish(flow);
    expect(errorOf(location)).toBe("token_invalid");
  });

  it("refuses a wrong RFC 9207 iss parameter", async () => {
    entra.issParameter = "https://evil.example.com";
    try {
      const { location } = await signInVia(entra, "corp", entraUser());
      expect(errorOf(location)).toBe("token_invalid");
    } finally {
      entra.issParameter = undefined;
    }
  });

  it("reports an IdP error answer (e.g. cancelled) without a session", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const res = await flow.browser.get(
      (() => {
        const u = entra.deny(flow.startLocation);
        return `${u.pathname}${u.search}`;
      })(),
    );
    expect(errorOf(res.headers.get("location") ?? "")).toBe("idp_error");
  });
});

describe("returnTo (open redirect)", () => {
  it.each([
    "//evil.example.com",
    "https://evil.example.com/x",
    "/\\evil.example.com",
    "/%2F%2Fevil",
  ])("lands %s on /", async (returnTo) => {
    const { location } = await signInVia(entra, "corp", entraUser(), returnTo);
    expect(location).toBe("http://kobe.test/");
  });
});

describe("groups overage (generic provider, access claim groups)", () => {
  it("creates a user from the groups claim (ES256 token)", async () => {
    const { location } = await signInVia(kc, "kc", {
      sub: "kc-user-1",
      email: "kc1@example.com",
      email_verified: true,
      groups: ["g-research"],
    });
    expect(errorOf(location)).toBeNull();
  });

  it("refuses an overage for an unlinked identity", async () => {
    const { location } = await signInVia(kc, "kc", {
      sub: "kc-user-2",
      email: "kc2@example.com",
      _claim_names: { groups: "src1" },
      _claim_sources: { src1: { endpoint: "https://graph.example.com" } },
    });
    expect(errorOf(location)).toBe("groups_overage");
  });

  it("KOBE-775: SCIM user provisioning without SCIM groups keeps the memberships and refuses", async () => {
    const user = { sub: "kc-user-775", email: "kc775@example.com", groups: ["g-research"] };
    const first = await signInVia(kc, "kc", user);
    expect(errorOf(first.location)).toBeNull();
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    const managed = async () =>
      (
        await h.admin.query<{ role: string; added_via: string | null }>(
          `SELECT role, added_via FROM team_members WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId],
        )
      ).rows;
    const before = await managed();
    expect(before).toEqual([{ role: "contributor", added_via: `idp:${kcId}` }]);
    // A SCIM token, as SCIM Users provisioning has, but nothing ever wrote SCIM groups.
    const { rows: token } = await h.admin.query<{ id: string }>(
      `INSERT INTO scim_tokens (provider_id, token_hash, prefix)
       VALUES ($1, $2, 'kobe_scim_y') RETURNING id`,
      [kcId, "b".repeat(64)],
    );
    try {
      const failedBefore = (await failures("groups_overage")).length;
      const overage = { ...user, groups: undefined, hasgroups: true };
      const res = await signInVia(kc, "kc", overage);
      expect(errorOf(res.location)).toBe("groups_overage");
      // Nothing was taken away; the refusal is in the audit log.
      expect(await managed()).toEqual(before);
      expect((await failures("groups_overage")).length).toBe(failedBefore + 1);
      // The person's earlier session (and their access) is untouched.
      expect((await first.browser.get("/v1/me")).status).toBe(200);
    } finally {
      await h.admin.query(`DELETE FROM scim_tokens WHERE id = $1`, [token[0]?.id]);
    }
  });

  it("KOBE-775 review M1: a site-role holder signs in on an overage, memberships unchanged", async () => {
    const user = { sub: "kc-admin-775", email: "kc-admin775@example.com", groups: ["g-research"] };
    const first = await signInVia(kc, "kc", user);
    expect(errorOf(first.location)).toBeNull();
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [userId]);
    const rows = async () =>
      (
        await h.admin.query(
          `SELECT team_id, role, added_via FROM team_members WHERE user_id = $1 ORDER BY team_id`,
          [userId],
        )
      ).rows;
    const before = await rows();
    expect(before).toHaveLength(1);
    const overage = { ...user, groups: undefined, hasgroups: true };
    const res = await signInVia(kc, "kc", overage);
    expect(errorOf(res.location)).toBeNull();
    expect((await res.browser.get("/v1/me")).json.user.id).toBe(userId);
    // No mapping was applied: nothing added or removed.
    expect(await rows()).toEqual(before);
    const { rows: audit } = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'auth.sign_in.succeeded' AND actor_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [userId],
    );
    expect(audit[0]?.target).toMatchObject({ method: "sso", groupsOverage: true });
  });

  it("refuses an overage for a linked user without SCIM, uses SCIM memberships with it", async () => {
    const user = { sub: "kc-user-3", email: "kc3@example.com", groups: ["g-research"] };
    const first = await signInVia(kc, "kc", user);
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    const overage = { ...user, groups: undefined, hasgroups: true };
    expect(errorOf((await signInVia(kc, "kc", overage)).location)).toBe("groups_overage");
    await h.admin.query(
      `INSERT INTO scim_tokens (provider_id, token_hash, prefix) VALUES ($1, $2, 'kobe_scim_x')`,
      [kcId, "a".repeat(64)],
    );
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO scim_groups (provider_id, external_id, display_name)
       VALUES ($1, 'g-research', 'Research') RETURNING id`,
      [kcId],
    );
    await h.admin.query(`INSERT INTO scim_group_members (group_id, user_id) VALUES ($1, $2)`, [
      rows[0]?.id,
      userId,
    ]);
    const ok = await signInVia(kc, "kc", overage);
    expect(errorOf(ok.location)).toBeNull();
    expect((await ok.browser.get("/v1/me")).json.user.id).toBe(userId);
  });
});
