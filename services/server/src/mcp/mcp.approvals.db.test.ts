import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DENY_UNVERIFIED_APPROVALS } from "./approvals.js";
import { createDbMcpCatalog } from "./catalog.js";
import { createMcpService } from "./service.js";
import { createToolRegistry } from "../policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { createDbRunContextSource } from "../sandbox-wire/index.js";
import { must } from "../testing/event-stream-fixture.js";
import { allowApproval, leaseRun, piName } from "../testing/mcp-fixtures.js";
import {
  fx,
  KEYRING,
  FORGED,
  app,
  internalApp,
  type World,
  world,
  type Body,
  auth,
  callTool,
  auditRows,
  digest,
  useMcpWorld,
} from "./mcp.test-helpers.js";

useMcpWorld();

describe("Gate 2: an MCP write runs only with a valid signed approval", () => {
  let w: World;
  const input = { q: "create the ticket" };
  const tool = () => piName(w.connector.name, "create_issue");
  const write = (body: Body = {}) =>
    callTool(w, { tool: "create_issue", arguments: input, ...body });

  beforeEach(async () => {
    w = await world();
  });

  it("refuses an unsigned call (a tampered kaiju-policy skipped the approval)", async () => {
    const res = await write();
    expect(res.json).toMatchObject({
      decision: "deny",
      code: "risk_write",
      approval_failure: "no_approval",
    });
    const [row] = await auditRows(w.team);
    expect(row?.target).toMatchObject({
      decision: "denied",
      reason: "risk_write",
      approvalFailure: "no_approval",
      risk: "write",
    });
  });

  it("allows the call with a valid signed approval, records it, and only once", async () => {
    const token = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const first = await write();
    expect(first.json).toMatchObject({
      decision: "allow",
      reason: "approval_granted",
      approval_id: token.approvalId,
      input_sha256: digest(input),
    });
    const second = await write();
    // Consumed: nothing usable is left for this run, tool and input.
    expect(second.json).toMatchObject({ decision: "deny", approval_failure: "no_approval" });
    // Naming the consumed approval's tool call explicitly does not revive it.
    const named = await write({ tool_call_id: token.toolCallId });
    expect(named.json).toMatchObject({ decision: "deny", approval_failure: "not_consumable" });
    const rows = await auditRows(w.team);
    expect(rows.map((r) => [r.target.decision, r.target.reason, r.target.approvalId])).toEqual([
      ["allowed", "approval_granted", token.approvalId],
      ["denied", "risk_write", undefined],
      ["denied", "risk_write", undefined],
    ]);
  });

  it("canonical input: key order and number spelling don't matter; the approved call runs once", async () => {
    const approvedInput = { q: "Résumé", labels: ["sec"], priority: 2 };
    const token = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input: approvedInput,
      key: KEYRING.current,
    });
    const send = () =>
      app.request(`/internal/v1/mcp/connectors/${w.connector.id}/calls`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth(w.token) },
        body: `{"tool":"create_issue","thread_id":"${w.threadId}","arguments":{"priority":2.0,"labels":["sec"],"q":"R\\u00e9sum\\u00e9"}}`,
      });
    expect(await (await send()).json()).toMatchObject({
      decision: "allow",
      reason: "approval_granted",
      approval_id: token.approvalId,
      input_sha256: digest(approvedInput),
    });
    expect(await (await send()).json()).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
  });

  it("refuses a forged signature", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: FORGED,
    });
    expect((await write()).json).toMatchObject({ decision: "deny", approval_failure: "bad_mac" });
  });

  it("refuses an approval replayed for a changed input", async () => {
    const token = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const changed = { q: "something else" };
    // Found by input: nothing approved matches the changed input.
    expect((await write({ arguments: changed })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
    // Named by tool call id: the MAC over the changed input does not verify.
    expect(
      (await write({ arguments: changed, tool_call_id: token.toolCallId })).json,
    ).toMatchObject({ decision: "deny", approval_failure: "bad_mac" });
  });

  it("refuses an expired approval", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
      now: new Date(Date.now() - 30 * 60_000),
    });
    expect((await write()).json).toMatchObject({ decision: "deny", approval_failure: "expired" });
  });

  it("refuses an approval of another tool of the same connector (delete with create's token)", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const res = await callTool(w, { tool: "delete_issue", arguments: input });
    expect(res.json).toMatchObject({
      decision: "deny",
      code: "risk_destructive",
      approval_failure: "no_approval",
    });
  });

  it("never reaches another user's approval in the same team, even by naming its tool call", async () => {
    const peer = await fx.person(`p${randomUUID().slice(0, 4)}`);
    await fx.addMember(w.team, peer);
    const peerRun = await fx.run(w.team, peer);
    const peerSandbox = randomUUID();
    const peerThread = await leaseRun(fx.admin, w.team, peerRun, peer.id, peerSandbox);
    const peers = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: peerRun,
      threadId: peerThread,
      userId: peer.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    // w's sandbox names the peer's thread: not its own run → no run at all.
    expect((await write({ thread_id: peerThread })).json).toMatchObject({
      decision: "deny",
      code: "run_not_active",
    });
    // w's own run, the peer's tool call id: the verifier looks only inside w's run.
    expect((await write({ tool_call_id: peers.toolCallId })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
  });

  it("refuses an approval of another run (replayed across runs)", async () => {
    const other = await world();
    await allowApproval(fx.admin, {
      teamId: other.team,
      runId: other.runId,
      threadId: other.threadId,
      userId: other.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    expect((await write()).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
  });

  it("refuses everything that needs approval while the deny-by-default stub is wired", async () => {
    const catalog = createDbMcpCatalog(fx.db);
    const stub = internalApp(
      createMcpService({
        db: fx.db,
        policy: {
          rules: createDbRuleSource(fx.db),
          settings: createDbSettingsSource(fx.db),
          registry: createToolRegistry(catalog),
          connectors: catalog,
        },
        runContext: createDbRunContextSource(),
        approvals: DENY_UNVERIFIED_APPROVALS,
      }),
    );
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const res = await callTool(w, { tool: "create_issue", arguments: input }, w.token, stub);
    expect(res.json).toMatchObject({ decision: "deny", approval_failure: "unavailable" });
    // Reads are not affected by the stub.
    expect((await callTool(w, { tool: "get_issue" }, w.token, stub)).json).toMatchObject({
      decision: "allow",
    });
  });
});

describe("scheduled runs never wait for approval at the proxy (KOBE-178, D32)", () => {
  const input = { q: "create the ticket" };
  const scheduled = async () => {
    const w = await world();
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [w.runId]);
    return w;
  };
  const skipped = async (w: World) =>
    (
      await fx.admin.query<{ tool: string; risk_class: string; reason: string }>(
        `SELECT tool, risk_class, reason FROM run_skipped_actions WHERE team_id = $1 AND run_id = $2`,
        [w.team, w.runId],
      )
    ).rows;
  const signedApproval = (w: World) =>
    allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: piName(w.connector.name, "create_issue"),
      input,
      key: KEYRING.current,
    });
  const consumed = async (w: World) =>
    (
      await fx.admin.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM approvals WHERE team_id = $1 AND run_id = $2`,
        [w.team, w.runId],
      )
    ).rows.map((r) => r.consumed_at);

  it("denies a write that would ask, records it, and a signed approval cannot stand in", async () => {
    const w = await scheduled();
    await signedApproval(w);
    const res = await callTool(w, { tool: "create_issue", arguments: input });
    expect(res.json).toMatchObject({ decision: "deny", code: "scheduled_run_no_prompt" });
    expect(res.json).not.toHaveProperty("approval_failure");
    expect(await consumed(w)).toEqual([null]);
    expect(await skipped(w)).toEqual([
      {
        tool: piName(w.connector.name, "create_issue"),
        risk_class: "write",
        reason: "scheduled_run_no_prompt",
      },
    ]);
  });

  it("an allow-listed write runs alone, but a stricter sibling run cannot turn it into an ask", async () => {
    const w = await scheduled();
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', $3, $2)`,
      [w.team, w.owner.id, piName(w.connector.name, "create_issue")],
    );
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "allow",
    });
    // An interactive run of the same sandbox would ask: the combined decision needs an approval,
    // which a scheduled run can never have.
    const sibling = await fx.run(w.team, w.owner);
    await leaseRun(fx.admin, w.team, sibling, w.owner.id, w.sandboxId);
    await signedApproval(w);
    const res = await callTool(w, { tool: "create_issue", arguments: input });
    expect(res.json).toMatchObject({ decision: "deny", code: "scheduled_run_no_prompt" });
    expect(await consumed(w)).toEqual([null]);
    expect((await skipped(w)).map((r) => r.reason)).toEqual(["scheduled_run_no_prompt"]);
  });

  it("read-only tools run and leave no skipped action; a deny rule is recorded with its code", async () => {
    const w = await scheduled();
    expect((await callTool(w, { tool: "get_issue" })).json).toMatchObject({ decision: "allow" });
    expect(await skipped(w)).toEqual([]);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'deny', $3, $2)`,
      [w.team, w.owner.id, piName(w.connector.name, "get_issue")],
    );
    expect((await callTool(w, { tool: "get_issue" })).json).toMatchObject({
      decision: "deny",
      code: "team_deny_rule",
    });
    expect((await skipped(w)).map((r) => r.reason)).toEqual(["team_deny_rule"]);
  });

  it("an interactive run's denied call is not a skipped action", async () => {
    const w = await world();
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
    expect(await skipped(w)).toEqual([]);
  });
});

describe("remembered approvals at the proxy (KOBE-289)", () => {
  const input = { q: "create the ticket" };
  const remembered = async (w: World) => {
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
       VALUES ($1, 'user', $2, 'allow', $3, $2, 'forever') RETURNING id`,
      [w.team, w.owner.id, piName(w.connector.name, "create_issue")],
    );
    return must(rows[0], "rule").id;
  };
  const audited = async (w: World) =>
    (
      await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
        `SELECT action, target FROM audit_log WHERE team_id = $1
            AND action IN ('policy.rule.applied', 'mcp.tool_call') ORDER BY seq`,
        [w.team],
      )
    ).rows;

  it("allows the write without an approval, audited naming the rule; revoking it denies at once", async () => {
    const w = await world();
    const ruleId = await remembered(w);
    const res = await callTool(w, { tool: "create_issue", arguments: input });
    expect(res.json).toMatchObject({ decision: "allow", reason: "user_allow_rule" });
    const rows = await audited(w);
    expect(rows.map((r) => r.action)).toEqual(["policy.rule.applied", "mcp.tool_call"]);
    expect(rows[0]?.target).toMatchObject({ ruleId, enforcementPoint: "mcp_proxy" });
    expect(rows[1]?.target).toMatchObject({ decision: "allowed", ruleId });
    await fx.admin.query(`DELETE FROM tool_rules WHERE id = $1`, [ruleId]);
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "deny",
    });
  });

  it("a thread rule never allows a call while another thread of the sandbox runs (review S1)", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope, thread_id)
       VALUES ($1, 'user', $2, 'allow', $3, $2, 'thread', $4)`,
      [w.team, w.owner.id, piName(w.connector.name, "create_issue"), w.threadId],
    );
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "allow",
      reason: "user_allow_rule",
    });
    // Thread B, same agent, project and mode, now runs in the same sandbox: a call naming thread
    // A could come from B, so A's rule can't decide it alone.
    const sibling = await fx.run(w.team, w.owner);
    await leaseRun(fx.admin, w.team, sibling, w.owner.id, w.sandboxId);
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
    await fx.complete(w.team, sibling);
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "allow",
    });
  });

  it("a scheduled run ignores it (D32): denied, recorded as skipped", async () => {
    const w = await world();
    await remembered(w);
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [w.runId]);
    expect((await callTool(w, { tool: "create_issue", arguments: input })).json).toMatchObject({
      decision: "deny",
      code: "scheduled_run_no_prompt",
    });
  });
});

describe("review M1: the thread claim never selects a laxer policy", () => {
  it("decides under every active run of the sandbox: an auto sibling cannot allow thread A's write", async () => {
    const w = await world();
    const sibling = await fx.run(w.team, w.owner);
    const siblingThread = await leaseRun(fx.admin, w.team, sibling, w.owner.id, w.sandboxId);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [sibling]);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', $3, $2)`,
      [w.team, w.owner.id, piName(w.connector.name, "create_issue")],
    );
    // Alone, the auto run would allow it (team allow-list for auto); with thread A active, approval is needed.
    expect(
      (await callTool(w, { tool: "create_issue", thread_id: siblingThread })).json,
    ).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
    await fx.complete(w.team, w.runId);
    expect(
      (await callTool(w, { tool: "create_issue", thread_id: siblingThread })).json,
    ).toMatchObject({
      decision: "allow",
    });
  });

  it("still allows a call every active run allows (a read with a sibling run)", async () => {
    const w = await world();
    const runId = await fx.run(w.team, w.owner);
    await leaseRun(fx.admin, w.team, runId, w.owner.id, w.sandboxId);
    expect((await callTool(w, { tool: "get_issue" })).json).toMatchObject({ decision: "allow" });
  });
});
