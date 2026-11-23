import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fx,
  world,
  newRun,
  endRun,
  check,
  approve,
  outcome,
  share,
  events,
  audits,
  limits,
  useRememberScopesWorld,
} from "./remember-scopes.test-helpers.js";

useRememberScopesWorld();

describe("approve all waiting", () => {
  it("allows every waiting approval of the run, each signed and audited on its own", async () => {
    const w = await world();
    const a = check(w, w, "share_file", share("a.md"));
    const b = check(w, w, "share_file", share("b.md"));
    const [pa, pb] = [await a.pending(), await b.pending()];
    const options = await w.owner.browser.get(`/v1/approvals/${pa.approval_id}/remember`);
    expect(options.json.approve_all.approval_ids).toEqual([pa.approval_id, pb.approval_id].sort());
    const res = await w.owner.browser.post("/v1/approvals/approve-all", {
      run_id: w.runId,
      approval_ids: [pa.approval_id, pb.approval_id],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.approvals.map((x: { status: string }) => x.status)).toEqual([
      "allowed",
      "allowed",
    ]);
    expect((await a.result()).decision).toBe("allow");
    expect((await b.result()).decision).toBe("allow");
    const { rows } = await fx.admin.query<{ id: string; input_hmac: string }>(
      `SELECT id, input_hmac FROM approvals WHERE run_id = $1 ORDER BY id`,
      [w.runId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.input_hmac)).size).toBe(2);
    const decided = await audits(w.team, "approval.decided");
    expect(decided).toHaveLength(2);
    for (const d of decided) expect(d).toMatchObject({ decision: "allow", approveAll: true });
    expect(
      (await events(w.team, w.runId)).filter((e) => e.type === "approval.resolved"),
    ).toHaveLength(2);
    await expect
      .poll(
        async () =>
          (await fx.admin.query(`SELECT status FROM runs WHERE id = $1`, [w.runId])).rows[0]
            ?.status,
      )
      .toBe("running");
  });

  it("is refused when any is destructive, by the team's limits, and for anyone else", async () => {
    const reader = await fx.person(`v${randomBytes(2).toString("hex")}`);
    const w = await world([reader]);
    const ask = await w.owner.browser.post("/v1/team/policy/rules", {
      effect: "ask",
      tool_glob: "bash",
    });
    expect(ask.status).toBe(201);
    const a = check(w, w, "share_file", share("a.md"));
    const b = check(w, w, "bash", { command: "ls" });
    const ids = [(await a.pending()).approval_id, (await b.pending()).approval_id];
    const options = await w.owner.browser.get(`/v1/approvals/${ids[0]}/remember`);
    expect(options.json.approve_all).toBeNull();
    const body = { run_id: w.runId, approval_ids: ids };
    expect(await w.owner.browser.post("/v1/approvals/approve-all", body)).toMatchObject({
      status: 403,
      json: { code: "approve_all_not_allowed" },
    });
    // A reader of the thread shared to the team can never decide it (404, as before).
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    expect((await reader.browser.post("/v1/approvals/approve-all", body)).status).toBe(404);
    expect((await reader.browser.get(`/v1/approvals/${ids[0]}/remember`)).status).toBe(404);
    expect(
      (await reader.browser.post(`/v1/approvals/${ids[0]}`, { decision: "allow" })).status,
    ).toBe(404);
    // Nothing was approved.
    const { rows } = await fx.admin.query(`SELECT status FROM approvals WHERE run_id = $1`, [
      w.runId,
    ]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    for (const id of ids) await w.owner.browser.post(`/v1/approvals/${id}`, { decision: "deny" });

    await w.owner.browser.put("/v1/team/policy/remember-limits", limits({ approve_all: false }));
    const c = check(w, w, "share_file", share("c.md"));
    const d = check(w, w, "share_file", share("d.md"));
    const more = [(await c.pending()).approval_id, (await d.pending()).approval_id];
    expect(
      await w.owner.browser.post("/v1/approvals/approve-all", {
        run_id: w.runId,
        approval_ids: more,
      }),
    ).toMatchObject({ status: 403, json: { code: "approve_all_not_allowed" } });
  });
});

describe("approve all waiting: only what the member saw, only one run (review S7)", () => {
  it("refuses an id from another run of the same member, and leaves a later arrival waiting", async () => {
    const w = await world();
    const other = await newRun(w);
    const a = check(w, w, "share_file", share("a.md"));
    const b = check(w, w, "share_file", share("b.md"));
    const elsewhere = check(w, other, "share_file", share("x.md"));
    const [pa, pb, px] = [await a.pending(), await b.pending(), await elsewhere.pending()];
    const options = await w.owner.browser.get(`/v1/approvals/${pa.approval_id}/remember`);
    const listed = options.json.approve_all.approval_ids as string[];
    expect(listed).toEqual([pa.approval_id, pb.approval_id].sort());
    expect(
      (
        await w.owner.browser.post("/v1/approvals/approve-all", {
          run_id: w.runId,
          approval_ids: [pa.approval_id, px.approval_id],
        })
      ).status,
    ).toBe(404);
    // A call that arrives after the options were read is not in the list: it keeps waiting.
    const late = check(w, w, "share_file", share("c.md"));
    const pl = await late.pending();
    const res = await w.owner.browser.post("/v1/approvals/approve-all", {
      run_id: w.runId,
      approval_ids: listed,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { rows } = await fx.admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM approvals WHERE id = ANY($1)`,
      [[pa.approval_id, pb.approval_id, pl.approval_id, px.approval_id]],
    );
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      [pa.approval_id]: "allowed",
      [pb.approval_id]: "allowed",
      [pl.approval_id]: "pending",
      [px.approval_id]: "pending",
    });
    for (const id of [pl.approval_id, px.approval_id]) {
      await w.owner.browser.post(`/v1/approvals/${id}`, { decision: "deny" });
    }
  });
});

describe("what the Approvals pages show (review S5, S6)", () => {
  it("a backfilled destructive rule shows as no longer applying; an admin never sees private values", async () => {
    const w = await world();
    // A KOBE-37 rule for bash (the API used to accept it), backfilled "until revoked".
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
       VALUES ($1, 'user', $2, 'allow', 'bash', $2, 'forever')`,
      [w.team, w.owner.id],
    );
    await fx.admin.query(`UPDATE threads SET title = 'Secret merger' WHERE id = $1`, [w.threadId]);
    await approve(w, w, "share_file", share("deal.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread", exact: true },
    });
    const mine = (await w.owner.browser.get("/v1/team/policy/my-rules")).json.rules;
    const bash = mine.find((r: { tool_glob: string }) => r.tool_glob === "bash");
    expect(bash).toMatchObject({
      applies: false,
      ended_reason: expect.stringMatching(/never remembered/),
    });
    const own = mine.find((r: { tool_glob: string }) => r.tool_glob === "share_file");
    expect(own).toMatchObject({
      applies: true,
      masked: false,
      thread_title: "Secret merger",
      arg_pattern: { "/path": "/workspace/deal.md" },
    });
    // The team admin's view of a private thread: tool, scope, shape and expiry only.
    const admin = (await w.owner.browser.get("/v1/team/policy/member-rules")).json.rules;
    const masked = admin.find((r: { tool_glob: string }) => r.tool_glob === "share_file");
    expect(masked).toMatchObject({
      masked: true,
      thread_id: null,
      thread_title: null,
      arg_pattern: null,
      arg_pointers: ["/path"],
      remember_scope: "thread",
    });
    expect(JSON.stringify(admin)).not.toMatch(/Secret merger|deal\.md/);
    // Shared with the team, the admin may read it anyway.
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    const shared = (await w.owner.browser.get("/v1/team/policy/member-rules")).json.rules;
    expect(shared.find((r: { tool_glob: string }) => r.tool_glob === "share_file")).toMatchObject({
      masked: false,
      thread_title: "Secret merger",
    });
  });

  it("an exact rule of a tool without a primary argument applies under exact-only, as the engine says (KOBE-783, P2-21)", async () => {
    const w = await world();
    const input = { scope: "project", path: "notes.md", content: "x" };
    const made = await approve(w, w, "remember", input, {
      decision: "allow",
      remember: { tool_glob: "remember", scope: "forever", exact: true },
    });
    expect(made.res.status, JSON.stringify(made.res.json)).toBe(200);
    // P2-23: the exact action is stored as canonical JSON too, the approval HMAC's form.
    const { rows } = await fx.admin.query<{ exact_keys: boolean; exact_input: string | null }>(
      `SELECT exact_keys, exact_input FROM tool_rules WHERE team_id = $1 AND scope = 'user'`,
      [w.team],
    );
    expect(rows).toEqual([
      { exact_keys: true, exact_input: '{"content":"x","path":"notes.md","scope":"project"}' },
    ]);
    const put = await w.owner.browser.put(
      "/v1/team/policy/remember-limits",
      limits({ exact_only: true }),
    );
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    // The engine still applies it...
    expect(await outcome(w, w, "remember", input)).toBe("allow");
    // ...so both Approvals pages say it applies (they used to say exact-only ended it).
    for (const path of ["/v1/team/policy/my-rules", "/v1/team/policy/member-rules"]) {
      const listed = (await w.owner.browser.get(path)).json.rules;
      expect(listed.find((r: { tool_glob: string }) => r.tool_glob === "remember")).toMatchObject({
        applies: true,
        ended_reason: null,
      });
    }
  });
});

describe("revocation and visibility", () => {
  it("a member's revoke and a team admin's revoke take effect at once, never across teams", async () => {
    const member = await fx.person(`m${randomBytes(2).toString("hex")}`);
    const w = await world();
    const other = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever" },
    });
    const mine = await w.owner.browser.get("/v1/team/policy/my-rules");
    expect(mine.json.rules).toEqual([
      expect.objectContaining({
        tool_glob: "share_file",
        remember_scope: "forever",
        user_id: w.owner.id,
      }),
    ]);
    const ruleId = mine.json.rules[0].id as string;
    // The admin of another team can't see or revoke it.
    expect((await other.owner.browser.get("/v1/team/policy/member-rules")).json.rules).toEqual([]);
    expect(
      (await other.owner.browser.delete(`/v1/team/policy/member-rules/${ruleId}`)).status,
    ).toBe(404);
    // A member who is not an admin can't list members' rules.
    await fx.addMember(w.team, member);
    await fx.activate(member, w.team);
    expect((await member.browser.get("/v1/team/policy/member-rules")).status).toBe(403);
    expect((await member.browser.delete(`/v1/team/policy/my-rules/${ruleId}`)).status).toBe(404);
    // The team admin sees it and revokes it: the next call asks.
    const listed = await w.owner.browser.get("/v1/team/policy/member-rules");
    expect(listed.json.rules.map((r: { id: string }) => r.id)).toEqual([ruleId]);
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    expect((await w.owner.browser.delete(`/v1/team/policy/member-rules/${ruleId}`)).status).toBe(
      204,
    );
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("ask");
    expect(await audits(w.team, "policy.rule.deleted")).toEqual([
      expect.objectContaining({ ruleId, scope: "user", rememberScope: "forever" }),
    ]);
  });

  it("scheduled and auto runs ignore remembered rules: denied, never queued", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    await endRun(w, w);
    for (const update of [
      `UPDATE runs SET trigger = 'schedule' WHERE id = $1`,
      `UPDATE runs SET approval_mode = 'auto' WHERE id = $1`,
    ]) {
      const run = await newRun(w, w.threadId);
      await fx.admin.query(update, [run.runId]);
      const call = check(w, run, "share_file", share("c.md"));
      const result = await call.result();
      expect(result.decision).toBe("deny");
      const { rows } = await fx.admin.query(`SELECT 1 FROM approvals WHERE run_id = $1`, [
        run.runId,
      ]);
      expect(rows).toHaveLength(0);
      await endRun(w, run);
    }
  });
});
