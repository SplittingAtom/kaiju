import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, canonicalJson, type PolicyInput } from "@kaiju/protocol";
import { approvalKeyring } from "./index.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { must } from "../testing/event-stream-fixture.js";
import {
  fx,
  mcpTool,
  CONNECTORS,
  registry,
  type World,
  world,
  check,
  askRule,
  decide,
  events,
  runStatus,
  approvalRow,
  audits,
  useApprovalsWorld,
} from "./approvals.test-helpers.js";

let skewMs = 0;
useApprovalsWorld(() => skewMs);

describe("expiry and run ends", () => {
  it("TTL: past 1 h the call is denied and the run fails visibly (stopped, queue advanced, audited)", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "sleep 1" });
    const pending = await call.pending();
    expect(Date.parse(pending.expires_at) - Date.now()).toBeGreaterThan(APPROVAL_TTL_MS - 60_000);
    skewMs = APPROVAL_TTL_MS + 1_000;
    try {
      const result = await call.result();
      expect(result.decision === "deny" && result.message).toMatch(/expired after 1 hour/);
      expect(await runStatus(w.team, w.runId)).toBe("failed");
      const evs = await events(w.team, w.runId);
      const types = evs.map((e) => e.type);
      expect(types.indexOf("approval.resolved")).toBeLessThan(types.indexOf("run.failed"));
      expect(evs.find((e) => e.type === "run.failed")?.payload).toMatchObject({
        error: { code: "approval_expired" },
      });
      expect(evs.find((e) => e.type === "approval.resolved")?.payload).toMatchObject({
        decision: "expired",
        cause: "ttl",
      });
      // Pi is told to abort; the orchestrator's hook advanced the thread.
      await w.sb.until(() =>
        w.sb
          .frames("run.stop")
          .find((f) => f.run_id === w.runId && f.reason === "approval_expired"),
      );
      const thread = await fx.admin.query<{ status: string }>(
        `SELECT status FROM threads WHERE id = $1`,
        [w.threadId],
      );
      expect(thread.rows[0]?.status).toBe("idle");
      expect((await audits(w.team, "approval.expired"))[0]?.target).toMatchObject({ cause: "ttl" });
      // A late decision is refused.
      expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(409);
    } finally {
      skewMs = 0;
    }
  });

  it("the sweep expires an approval nobody waits on", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    skewMs = APPROVAL_TTL_MS + 60_000;
    try {
      await fx.replica(1).deps.approvals.sweep(0);
      expect((await approvalRow(pending.approval_id)).status).toBe("expired");
      expect((await call.result()).decision).toBe("deny");
    } finally {
      skewMs = 0;
    }
  });

  it("Stop while pending: the approval expires (run_cancelled) before the run's terminal event", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    const stop = await w.owner.browser.post(`/v1/runs/${w.runId}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBe(200);
    expect((await call.result()).decision).toBe("deny");
    expect(await approvalRow(pending.approval_id)).toMatchObject({
      status: "expired",
      cause: "run_cancelled",
    });
    const types = (await events(w.team, w.runId)).map((e) => e.type);
    expect(types.indexOf("approval.resolved")).toBeLessThan(types.indexOf("run.interrupted"));
    expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(409);
  });

  it("a budget stop expires pending approvals (D30) and lets the step finish", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    await fx.replica(1).deps.runs.stopForBudget({ team_id: w.team, scope: "team" });
    const result = await call.result();
    expect(result.decision === "deny" && result.reasons[0]?.code).toBe("budget_exhausted");
    expect(await approvalRow(pending.approval_id)).toMatchObject({ cause: "budget_exhausted" });
    // No longer waiting: the step finishes (running), then the run ends budget_stopped as soon as
    // the sandbox answers the after-step stop (the fake answers at once).
    expect(["running", "budget_stopped"]).toContain(await runStatus(w.team, w.runId));
  });

  it("the sandbox connection closing while pending expires it; the run goes back to running", async () => {
    const w = await world();
    await askRule(w, "bash");
    const pending = await check(w, "bash", { command: "true" }).pending();
    w.sb.close();
    await expect.poll(async () => (await approvalRow(pending.approval_id)).status).toBe("expired");
    expect((await approvalRow(pending.approval_id)).cause).toBe("run_interrupted");
    expect(await runStatus(w.team, w.runId)).toBe("running");
  });
});

describe("Gate 2: a tampered kaiju-policy cannot run an MCP write without a signed approval", () => {
  const TOOL = "mcp__jira__create_issue";
  const INPUT = { project: "OPS", summary: "R\u00e9sum\u00e9 keys", labels: ["sec"], priority: 2 };
  const verifier = () => fx.replica(1).deps.approvals.verifier;
  const engine = () =>
    createPolicyEngine({
      rules: createDbRuleSource(fx.db),
      settings: createDbSettingsSource(fx.db, 0),
      registry,
      connectors: CONNECTORS,
    });
  const proxyInput = (
    w: World,
    toolCallId: string,
    input: Record<string, unknown>,
  ): PolicyInput => ({
    actor: { user_id: w.owner.id, kind: "user" },
    team_id: w.team,
    agent: {
      agent_id: null,
      version: null,
      tools_allow: [],
      tools_deny: [],
      dangerous_tools: [],
    },
    run: { run_id: w.runId, thread_id: w.threadId, approval_mode: "ask-on-write" },
    tool: mcpTool(TOOL, "write"),
    tool_call_id: toolCallId,
    input: input as PolicyInput["input"],
    context: { enforcement_point: "mcp_proxy", connector_exposure: "all" },
  });

  /** A properly approved MCP call (through the sandbox and the API). */
  async function approved(w: World, toolCallId: string) {
    const call = check(w, TOOL, INPUT, toolCallId);
    const pending = await call.pending();
    expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(200);
    expect((await call.result()).decision).toBe("allow");
    return pending.approval_id;
  }

  it("the policy re-check at the proxy requires approval for the write (no allow by itself)", async () => {
    const w = await world();
    const decision = await engine().decide(proxyInput(w, "tc-none", INPUT));
    expect(decision.effect).toBe("require_approval");
  });

  // The proxy's whole decision (decideMcpCall) is covered in mcp.db.test.ts (KOBE-776: the
  // older enforceMcpCall composition is gone); these cases pin the verifier it uses.
  it("refuses a call that never asked (the extension skipped policy.check)", async () => {
    const w = await world();
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "skipped",
        tool: TOOL,
        input: INPUT,
      }),
    ).toEqual({ ok: false, reason: "no_approval" });
    expect((await audits(w.team, "approval.rejected"))[0]?.target).toMatchObject({
      reason: "no_approval",
      enforcementPoint: "mcp_proxy",
    });
  });

  it("refuses a changed input, another user, a pending or denied approval", async () => {
    const w = await world();
    const id = await approved(w, "tc-a");
    const tampered = { ...INPUT, summary: "Delete everything" };
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-a",
        tool: TOOL,
        input: tampered,
      }),
    ).toEqual({ ok: false, reason: "bad_mac" });
    // Unicode is not normalised: NFD of an approved NFC string is another input.
    expect(
      (
        await verifier().authorize({
          teamId: w.team,
          userId: w.owner.id,
          runId: w.runId,
          toolCallId: "tc-a",
          tool: TOOL,
          input: { ...INPUT, summary: INPUT.summary.normalize("NFD") },
        })
      ).ok,
    ).toBe(false);
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: randomUUID(),
        runId: w.runId,
        toolCallId: "tc-a",
        tool: TOOL,
        input: INPUT,
      }),
    ).toEqual({ ok: false, reason: "record_mismatch" });
    // The genuine call still works once (the refusals above consumed nothing).
    expect((await approvalRow(id)).consumed_at).toBeNull();
    const pendingCall = check(w, TOOL, INPUT, "tc-pending");
    await pendingCall.pending();
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-pending",
        tool: TOOL,
        input: INPUT,
      }),
    ).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("canonical input: key order and number spelling don't matter; the exact approved call runs once", async () => {
    const w = await world();
    const id = await approved(w, "tc-c");
    const reordered = JSON.parse(
      '{"priority":2.0,"labels":["sec"],"summary":"R\\u00e9sum\\u00e9 keys","project":"OPS"}',
    ) as Record<string, unknown>;
    expect(canonicalJson(reordered)).toBe(canonicalJson(INPUT));
    const call = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      toolCallId: "tc-c",
      tool: TOOL,
    };
    expect(await verifier().authorize({ ...call, input: reordered })).toEqual({
      ok: true,
      approvalId: id,
    });
    expect((await approvalRow(id)).consumed_at).not.toBeNull();
    // Replay of the same approved call: consumed.
    expect(await verifier().authorize({ ...call, input: INPUT })).toEqual({
      ok: false,
      reason: "not_consumable",
    });
    expect((await audits(w.team, "approval.consumed")).map((a) => a.target.approvalId)).toEqual([
      id,
    ]);
  });

  it("refuses another tool call id, another run, another tool, an expired token and an ended run", async () => {
    const w = await world();
    await approved(w, "tc-d");
    const base = { teamId: w.team, userId: w.owner.id, runId: w.runId, tool: TOOL, input: INPUT };
    // The approval of tc-d is not an approval of tc-e (replayed under a new id).
    expect(await verifier().authorize({ ...base, toolCallId: "tc-e" })).toEqual({
      ok: false,
      reason: "no_approval",
    });
    // A different run of the same user.
    const other = await fx.run(w.team, w.owner);
    expect(await verifier().authorize({ ...base, runId: other, toolCallId: "tc-d" })).toEqual({
      ok: false,
      reason: "no_approval",
    });
    // The same ids, another (destructive) tool.
    expect(
      await verifier().authorize({ ...base, toolCallId: "tc-d", tool: "mcp__jira__delete_issue" }),
    ).toEqual({ ok: false, reason: "binding_mismatch" });
    // The token lives 10 minutes from the decision.
    skewMs = 11 * 60_000;
    try {
      expect(await verifier().authorize({ ...base, toolCallId: "tc-d" })).toEqual({
        ok: false,
        reason: "expired",
      });
    } finally {
      skewMs = 0;
    }
    // The run ended (Stop): its approvals can't be used any more.
    await approved(w, "tc-f");
    expect((await w.owner.browser.post(`/v1/runs/${w.runId}/cancel`, {})).status).toBe(200);
    expect(await verifier().authorize({ ...base, toolCallId: "tc-f" })).toEqual({
      ok: false,
      reason: "run_inactive",
    });
  });

  it("a token signed with another key does not verify (the sandbox never holds the key)", async () => {
    const w = await world();
    const id = await approved(w, "tc-k");
    // Rewrite the stored MAC as a sandbox would have to forge it: any other key.
    const forged = approvalKeyring("a-different-key-the-sandbox-made-up".padEnd(48, "x"));
    const { rows } = await fx.admin.query<{ token_expires_at: Date }>(
      `SELECT token_expires_at FROM approvals WHERE id = $1`,
      [id],
    );
    const { computeApprovalMac } = await import("@kaiju/protocol/node");
    const mac = computeApprovalMac(
      forged.current.secret,
      {
        team_id: w.team,
        run_id: w.runId,
        tool_call_id: "tc-k",
        tool: TOOL,
        expires_at: must(rows[0], "row").token_expires_at.toISOString(),
      },
      { ...INPUT, summary: "forged" },
    );
    await fx.admin.query(`UPDATE approvals SET input_hmac = $1 WHERE id = $2`, [mac, id]);
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-k",
        tool: TOOL,
        input: { ...INPUT, summary: "forged" },
      }),
    ).toEqual({ ok: false, reason: "bad_mac" });
  });
});
