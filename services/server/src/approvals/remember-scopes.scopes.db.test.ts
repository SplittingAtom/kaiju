import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_REMEMBER_LIMITS } from "@kaiju/protocol";
import { must } from "../testing/event-stream-fixture.js";
import {
  fx,
  siteAdmin,
  world,
  newRun,
  endRun,
  check,
  approve,
  outcome,
  share,
  events,
  audits,
  rules,
  limits,
  useRememberScopesWorld,
} from "./remember-scopes.test-helpers.js";

useRememberScopesWorld();

describe("thread scope (this conversation)", () => {
  it("holds in its thread only, is announced and audited, and ends when the thread is archived", async () => {
    const w = await world();
    const { res } = await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(res.json).toMatchObject({ status: "allowed", remembered: true });
    const [rule] = await rules(w.team);
    expect(rule).toMatchObject({ remember_scope: "thread", thread_id: w.threadId, run_id: null });
    expect(rule?.expires_at).toBeNull();

    // Same thread: runs without asking, and the tool card and audit name the rule.
    const next = check(w, w, "share_file", share("b.md"));
    expect((await next.result()).decision).toBe("allow");
    const applied = (await events(w.team, w.runId)).find((e) => e.type === "policy.rule_applied");
    expect(applied?.payload).toEqual({
      tool_call_id: next.toolCallId,
      tool: "share_file",
      rule_id: rule?.id,
      scope: "thread",
    });
    expect(await audits(w.team, "policy.rule.applied")).toEqual([
      {
        ruleId: rule?.id,
        runId: w.runId,
        toolCallId: next.toolCallId,
        tool: "share_file",
        rememberScope: "thread",
        enforcementPoint: "sandbox",
      },
    ]);
    expect((await rules(w.team))[0]?.last_used_at).not.toBeNull();

    // Another thread of the same member still asks.
    const other = await newRun(w);
    expect(await outcome(w, other, "share_file", share("c.md"))).toBe("ask");
    // While it runs, a thread rule asks in its own thread too (KOBE-800: share_file is decided
    // under every active run of the sandbox, as connector calls are).
    expect(await outcome(w, w, "share_file", share("c2.md"))).toBe("ask");
    await endRun(w, other);

    // A later run in the same thread keeps it; archiving the thread ends it.
    await endRun(w, w);
    const again = await newRun(w, w.threadId);
    expect(await outcome(w, again, "share_file", share("d.md"))).toBe("allow");
    expect((await w.owner.browser.post(`/v1/threads/${w.threadId}/archive`)).status).toBe(200);
    expect(await outcome(w, again, "share_file", share("e.md"))).toBe("ask");
    expect((await w.owner.browser.get("/v1/team/policy/my-rules")).json.rules).toEqual([]);
  });

  it.each([
    ["archived, then unarchived", "archive"],
    ["moved to Trash, then restored", "trash"],
    ["moved to a project, then back", "move"],
  ] as const)("ends for good when the thread is %s (review S2)", async (_name, how) => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    const [rule] = await rules(w.team);
    await endRun(w, w);
    const t = `/v1/threads/${w.threadId}`;
    const ok = (res: { status: number; json: unknown }) =>
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    if (how === "archive") {
      ok(await w.owner.browser.post(`${t}/archive`));
      ok(await w.owner.browser.post(`${t}/unarchive`));
    } else if (how === "trash") {
      ok(await w.owner.browser.delete(t));
      ok(await w.owner.browser.post(`${t}/restore`));
    } else {
      const project = await w.owner.browser.post("/v1/projects", { name: "Elsewhere" });
      expect(project.status, JSON.stringify(project.json)).toBe(201);
      ok(await w.owner.browser.post(`${t}/move`, { project_id: project.json.id }));
      ok(await w.owner.browser.post(`${t}/move`, { project_id: null }));
    }
    expect(await rules(w.team)).toEqual([]);
    expect(await audits(w.team, "policy.rule.deleted")).toEqual([
      expect.objectContaining({ ruleId: rule?.id, rememberScope: "thread" }),
    ]);
    const again = await newRun(w, w.threadId);
    expect(await outcome(w, again, "share_file", share("c.md"))).toBe("ask");
  });

  it("can't be made for an archived thread, so unarchiving brings nothing back (review R1)", async () => {
    const w = await world();
    const call = check(w, w, "share_file", share("a.md"));
    const pending = await call.pending();
    // The member archives the thread while the call waits, then answers it.
    expect((await w.owner.browser.post(`/v1/threads/${w.threadId}/archive`)).status).toBe(200);
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    expect(options.json.choices.map((c: { scope: string }) => c.scope)).not.toContain("thread");
    const refused = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(refused).toMatchObject({ status: 403, json: { code: "remember_not_allowed" } });
    expect(await rules(w.team)).toEqual([]);
    await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, { decision: "allow" });
    expect((await call.result()).decision).toBe("allow");
    expect((await w.owner.browser.post(`/v1/threads/${w.threadId}/unarchive`)).status).toBe(200);
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("ask");
  });

  it("holds while the thread is in a project of the workspace (every member reads it, RV1)", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by)
       VALUES ($1, $2, $3, 'Unlisted', $4)`,
      [w.team, project, `p-${project.slice(0, 8)}`, w.owner.id],
    );
    // A plain member without a row is an implicit reader: the project stays in reach.
    await fx.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.owner.id],
    );
    await fx.admin.query(`UPDATE threads SET project_id = $2 WHERE id = $1`, [w.threadId, project]);
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("allow");
  });
});

describe("run scope (this run only)", () => {
  it("holds in its run only", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "run" },
    });
    expect(await rules(w.team)).toEqual([
      expect.objectContaining({ remember_scope: "run", run_id: w.runId, thread_id: null }),
    ]);
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    await endRun(w, w);
    // A new run in the same thread (as Regenerate or the next message makes) asks again.
    const later = await newRun(w, w.threadId);
    expect(await outcome(w, later, "share_file", share("c.md"))).toBe("ask");
    // The ended run's rule is pruned (audited, by the system) when the member makes a new one.
    const [old] = await rules(w.team);
    await approve(w, later, "share_file", share("d.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "run" },
    });
    expect((await rules(w.team)).map((r) => r.run_id)).toEqual([later.runId]);
    const { rows } = await fx.admin.query<{ actor_kind: string; target: { ruleId: string } }>(
      `SELECT actor_kind::text, target FROM audit_log
        WHERE team_id = $1 AND action = 'policy.rule.deleted' ORDER BY seq`,
      [w.team],
    );
    expect(rows).toEqual([
      { actor_kind: "system", target: expect.objectContaining({ ruleId: old?.id }) },
    ]);
  });
});

describe("until end of today", () => {
  it("expires at midnight in the member's stored time zone", async () => {
    const w = await world();
    expect((await w.owner.browser.put("/v1/me/time-zone", { time_zone: "Not/AZone" })).status).toBe(
      400,
    );
    expect(
      (await w.owner.browser.put("/v1/me/time-zone", { time_zone: "Pacific/Kiritimati" })).json,
    ).toEqual({ time_zone: "Pacific/Kiritimati" });
    const call = check(w, w, "share_file", share("a.md"));
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    const today = options.json.choices.find((c: { scope: string }) => c.scope === "today");
    expect(options.json.time_zone).toBe("Pacific/Kiritimati");
    const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "today" },
    });
    expect(res.status).toBe(200);
    const expires = must((await rules(w.team))[0]?.expires_at, "expiry");
    // Midnight at UTC+14 is 10:00 UTC; the card showed the same instant before saving.
    expect(expires.getUTCHours()).toBe(10);
    expect(expires.getUTCMinutes()).toBe(0);
    expect(expires.getTime()).toBeGreaterThan(Date.now());
    expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(Math.abs(Date.parse(today.expires_at) - expires.getTime())).toBeLessThan(5_000);
  });
});

describe("only this exact action", () => {
  it("is derived from the stored input, shown first, and allows exactly that action", async () => {
    const w = await world();
    const call = check(w, w, "share_file", { path: "reports/../q3*.md" });
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    // A path tool pins only the path (the card says the content may differ).
    expect(options.json.exact).toEqual({
      arg_pattern: { "/path": "/workspace/q3\\*.md" },
      pins_all: false,
    });
    const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever", exact: true },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await rules(w.team))[0]?.arg_pattern).toEqual({ "/path": "/workspace/q3\\*.md" });
    expect(await outcome(w, w, "share_file", { path: "/workspace/q3*.md" })).toBe("allow");
    // A glob character is literal: q3x.md is another action.
    expect(await outcome(w, w, "share_file", { path: "/workspace/q3x.md" })).toBe("ask");
  });

  it("refuses a client-chosen pattern and too broad a tool glob", async () => {
    const w = await world();
    const call = check(w, w, "share_file", share("a.md"));
    const pending = await call.pending();
    const id = pending.approval_id;
    const sent = (remember: object) =>
      w.owner.browser.post(`/v1/approvals/${id}`, { decision: "allow", remember });
    expect(
      (await sent({ tool_glob: "share_file", scope: "day", arg_pattern: { "/path": "*" } })).json,
    ).toMatchObject({ code: "invalid_request" });
    expect((await sent({ tool_glob: "share_*", scope: "day" })).json).toMatchObject({
      code: "glob_too_broad",
    });
    expect(await rules(w.team)).toEqual([]);
  });
});

describe("admin limits", () => {
  it("the card offers only allowed choices, the server refuses others, and tightening applies at once", async () => {
    const w = await world();
    // An existing until-revoked rule from before the limits.
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");

    const put = await w.owner.browser.put(
      "/v1/team/policy/remember-limits",
      limits({ scopes: ["thread", "run", "today"], approve_all: false }),
    );
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.effective.scopes).toEqual(["thread", "today", "run"]);
    // The until-revoked rule stops applying at once.
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("ask");

    const call = check(w, w, "remember", { scope: "project", path: "notes.md", content: "x" });
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    expect(options.json.choices.map((c: { scope: string }) => c.scope)).toEqual([
      "thread",
      "today",
      "run",
    ]);
    const refused = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "remember", scope: "month" },
    });
    expect(refused).toMatchObject({ status: 403, json: { code: "remember_not_allowed" } });
    await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, { decision: "deny" });
    expect(await audits(w.team, "policy.remember_limits.updated")).toEqual([
      expect.objectContaining({ scope: "team", approveAll: false }),
    ]);
  });

  it("the site floor binds every team, and a team can only tighten it", async () => {
    const w = await world();
    const floor = limits({ scopes: ["thread", "run"], max_duration_seconds: 3600 });
    expect((await siteAdmin.browser.put("/v1/site/policy/remember-limits", floor)).status).toBe(
      200,
    );
    try {
      const looser = await w.owner.browser.put("/v1/team/policy/remember-limits", limits({}));
      expect(looser).toMatchObject({ status: 400, json: { code: "limits_above_floor" } });
      expect(looser.json.fields).toEqual(["scopes", "max_duration_seconds"]);
      const read = await w.owner.browser.get("/v1/team/policy/remember-limits");
      expect(read.json.effective).toMatchObject({
        scopes: ["thread", "run"],
        max_duration_seconds: 3600,
      });
      // Members (not admins) can read the limits but never change them.
      const call = check(w, w, "share_file", share("a.md"));
      const pending = await call.pending();
      const refused = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
        decision: "allow",
        remember: { tool_glob: "share_file", scope: "day" },
      });
      expect(refused.json).toMatchObject({ code: "remember_not_allowed" });
      const ok = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
        decision: "allow",
        remember: { tool_glob: "share_file", scope: "thread" },
      });
      expect(ok.status).toBe(200);
      // Capped by the floor's max duration even though threads have no time of their own.
      const expires = must((await rules(w.team))[0]?.expires_at, "expiry");
      expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
    } finally {
      await siteAdmin.browser.put("/v1/site/policy/remember-limits", DEFAULT_REMEMBER_LIMITS);
    }
  });

  it("members can't set limits", async () => {
    const member = await fx.person(`m${randomBytes(2).toString("hex")}`);
    const w = await world([member]);
    expect((await member.browser.put("/v1/team/policy/remember-limits", limits({}))).status).toBe(
      403,
    );
    expect((await member.browser.get("/v1/team/policy/remember-limits")).status).toBe(200);
    expect((await member.browser.get("/v1/site/policy/remember-limits")).status).toBe(403);
    void w;
  });
});
