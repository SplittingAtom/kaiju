import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "@kaiju/db";
import { delegationBacked, delegationBacking } from "./delegation-live.js";
import { TestBrowser } from "../testing/browser.js";
import { PUBLIC_URL } from "../testing/event-stream-fixture.js";
import { INTERNAL_KEY, mcpToken } from "../testing/mcp-fixtures.js";
import {
  fx,
  setSite,
  world,
  sandboxFor,
  call,
  roleOf,
  approve,
  decisions,
  useKaijuMcpWorld,
} from "./kaiju-mcp.test-helpers.js";

useKaijuMcpWorld();

describe("audit records the person via agent (ac-5)", () => {
  it("the console's own event, actor the person, with thread, run and tool call; chain verifies", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "team_admin" };
    const approval = await approve(s, "team_members_set_role", input);
    expect(
      (await call(s, "team_members_set_role", input, approval.toolCallId)).isError,
    ).toBeUndefined();
    const { rows } = await fx.admin.query<{
      actor_kind: string;
      actor_id: string;
      target: Record<string, unknown>;
      ip: string | null;
    }>(
      `SELECT actor_kind, actor_id, target, ip FROM audit_log
        WHERE team_id = $1 AND action = 'identity.member.role_changed' ORDER BY seq`,
      [w.team],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_id: w.admin.id,
      ip: null,
      target: {
        userId: w.target.id,
        from: "member",
        to: "team_admin",
        viaAgent: { threadId: s.threadId, runId: s.runId, toolCallId: approval.toolCallId },
      },
    });
    expect((await verifyAuditChain(fx.db)).ok).toBe(true);
  });
});

describe("no header or route on the public listener accepts a delegation (ac-6)", () => {
  it("a real HTTP request with every plausible delegation claim is unauthenticated", async () => {
    const w = await world();
    const app = fx.replica(0).app;
    const server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const delegation = {
        userId: w.admin.id,
        teamId: w.team,
        runId: randomUUID(),
        threadId: randomUUID(),
        toolCallId: "t1",
      };
      const claim = JSON.stringify(delegation);
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/team/members/${w.target.id}?delegation=${encodeURIComponent(claim)}`,
        {
          method: "PATCH",
          headers: {
            origin: PUBLIC_URL,
            "content-type": "application/json",
            "x-kobe-team": w.team,
            "kaiju-delegation": claim,
            "x-kobe-delegation": claim,
            "kobe-sandbox-token": mcpToken({
              sandboxId: randomUUID(),
              teamId: w.team,
              userId: w.admin.id,
            }),
            authorization: `Bearer ${INTERNAL_KEY}`,
          },
          body: JSON.stringify({ role: "team_admin", delegation }),
        },
      );
      expect(res.status).toBe(401);
      expect(await roleOf(w.team, w.target.id)).toBe("member");
      // The Kaiju endpoints exist on the internal listener only.
      for (const path of ["/internal/v1/mcp/kobe/calls", "/v1/internal/v1/mcp/kobe/calls"]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
        // 403: the CSRF origin check answers first for a POST without the site's origin.
        expect([401, 403, 404], path).toContain(r.status);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("an in-process env without a minted delegation is not one either", async () => {
    const w = await world();
    const app = fx.replica(0).app;
    const forged = {
      [Symbol.for("kaiju.delegation")]: { userId: w.admin.id, teamId: w.team },
      [Symbol("kaiju.delegation")]: {
        userId: w.admin.id,
        teamId: w.team,
        runId: randomUUID(),
        threadId: randomUUID(),
        toolCallId: "t",
      },
      delegation: { userId: w.admin.id, teamId: w.team },
    };
    const res = await app.request(
      `/v1/team/members/${w.target.id}`,
      {
        method: "PATCH",
        headers: { origin: PUBLIC_URL, "content-type": "application/json", "x-kobe-team": w.team },
        body: JSON.stringify({ role: "team_admin" }),
      },
      forged,
    );
    expect(res.status).toBe(401);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });
});

// The catalog contract for every Team console tool (without the permission: not listed and
// refused; with it: listed and working; the console's own audit event) is in
// `kaiju-mcp-team.db.test.ts` (KOBE-621).

describe("review fixes (KOBE-619)", () => {
  it("M1: signing out everywhere mid-run stops the run's admin tools", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    await fx.replica(0).deps.revokeAllSessions(w.admin.id);
    const after = await call(s, "team_members_list", {});
    expect(after.isError).toBe(true);
    // Signing in again later does not revive a run started before the revocation.
    const again = await new TestBrowser(fx.replica(0).app, PUBLIC_URL).post(
      "/api/auth/sign-in/email",
      { email: w.admin.email, password: "a long enough password" },
    );
    expect(again.status).toBe(200);
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
  });

  it("SSO review A: an SSO-backed delegation obeys the kill switch and max_session_hours", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    // The person's sessions are SSO sign-ins of a provider capping them at 1 hour.
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim, access_claim, max_session_hours, managed_by, enabled)
       VALUES ($1, 'P', 'oidc', 'https://idp.example.com', 'c', 'sub', 'groups', 1, 'helm', true) RETURNING id`,
      [`p-${randomUUID().slice(0, 8)}`],
    );
    const providerId = rows[0]?.id;
    await fx.admin.query(
      `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied)
       SELECT id, $2, false FROM sessions WHERE user_id = $1`,
      [w.admin.id, providerId],
    );
    const link = () =>
      fx.admin.query(
        `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via)
         VALUES ($1, 'subject-a', $2, 'jit')`,
        [providerId, w.admin.id],
      );
    await link();
    const db = fx.replica(0).deps.database.db;
    const d = {
      userId: w.admin.id,
      teamId: w.team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "tc",
    };
    // This fixture runs with single sign-on off: the kill switch refuses the delegation.
    expect(fx.replica(0).deps.sso.settings.enabled).toBe(false);
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
    expect(await delegationBacked(db, d, { ssoEnabled: false })).toBe(false);
    // With SSO on, the backing session counts while within its provider's hours.
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    // KOBE-775: not while its provider is off, nor once the person is unlinked from it.
    await fx.admin.query(`UPDATE sso_providers SET enabled = false WHERE id = $1`, [providerId]);
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(false);
    await fx.admin.query(`UPDATE sso_providers SET enabled = true WHERE id = $1`, [providerId]);
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    await fx.admin.query(`DELETE FROM sso_identities WHERE provider_id = $1`, [providerId]);
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(false);
    await link();
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    await fx.admin.query(
      `UPDATE sessions SET created_at = created_at - interval '2 hours' WHERE user_id = $1`,
      [w.admin.id],
    );
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(false);
  });

  it("KOBE-629: under require_2fa a delegation needs a backing session that passed 2FA itself", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim, access_claim, managed_by, enabled)
       VALUES ($1, 'P', 'oidc', 'https://idp.example.com', 'c', 'sub', 'groups', 'helm', true) RETURNING id`,
      [`p-${randomUUID().slice(0, 8)}`],
    );
    await fx.admin.query(
      `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied)
       SELECT id, $2, false FROM sessions WHERE user_id = $1`,
      [w.admin.id, rows[0]?.id],
    );
    await fx.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via)
       VALUES ($1, 'subject-b', $2, 'jit')`,
      [rows[0]?.id, w.admin.id],
    );
    const db = fx.replica(0).deps.database.db;
    const d = {
      userId: w.admin.id,
      teamId: w.team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "tc",
    };
    const opts = { ssoEnabled: true, ssoMfaProof: true };
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    expect(await delegationBacked(db, d, opts)).toBe(false);
    // KOBE-731: requireSession reads both answers in one query.
    const both = (withMfaProof: boolean) => ({ backed: true, withMfaProof });
    expect(await delegationBacking(db, d, { ssoEnabled: true })).toEqual(both(false));
    await fx.admin.query(
      `UPDATE session_sso_contexts SET mfa_satisfied = true
        WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
      [w.admin.id],
    );
    expect(await delegationBacked(db, d, opts)).toBe(true);
    // Review L1: an SSO backing session counts only on its own proof; Kaiju TOTP never stands in.
    await fx.admin.query(
      `UPDATE session_sso_contexts SET mfa_satisfied = false
        WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
      [w.admin.id],
    );
    await fx.admin.query(`UPDATE users SET two_factor_enabled = true WHERE id = $1`, [w.admin.id]);
    expect(await delegationBacked(db, d, opts)).toBe(false);
    // A local backing session counts with the person's enrolled TOTP, and only with it.
    await fx.admin.query(
      `DELETE FROM session_sso_contexts
        WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
      [w.admin.id],
    );
    expect(await delegationBacked(db, d, opts)).toBe(true);
    expect(await delegationBacking(db, d, { ssoEnabled: true })).toEqual(both(true));
    await fx.admin.query(`UPDATE users SET two_factor_enabled = false WHERE id = $1`, [w.admin.id]);
    expect(await delegationBacked(db, d, opts)).toBe(false);
    expect(await delegationBacking(db, d, { ssoEnabled: true })).toEqual(both(false));
    expect(await delegationBacking(db, d, { ssoEnabled: false })).toEqual({
      backed: true,
      withMfaProof: false,
    });
  });

  it("L3: the role change itself refuses another before-state (409 changed_since_approval)", async () => {
    const w = await world();
    const res = await w.admin.browser.patch(`/v1/team/members/${w.target.id}`, {
      role: "team_admin",
      expectedRole: "contributor",
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "changed_since_approval" });
    expect(await roleOf(w.team, w.target.id)).toBe("member");
    const ok = await w.admin.browser.patch(`/v1/team/members/${w.target.id}`, {
      role: "contributor",
      expectedRole: "member",
    });
    expect(ok.status).toBe(200);
  });

  it("L4: a target who left the team is not_a_member, not changed_since_approval", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", input);
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.target.id,
    ]);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not_a_member");
  });

  it("L5: concurrent writes cannot both pass the per-person limit", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.writes_per_hour", "1");
    const a = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    const b = { user_id: w.member.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", a);
    await approve(s, "team_members_set_role", b);
    const outs = await Promise.all([
      call(s, "team_members_set_role", a),
      call(s, "team_members_set_role", b),
    ]);
    expect(outs.filter((o) => o.isError === undefined)).toHaveLength(1);
    const allowed = (await decisions(w.team)).filter(
      (d) => d.decision === "allowed" && d.risk !== "read",
    );
    expect(allowed).toHaveLength(1);
  });
});
