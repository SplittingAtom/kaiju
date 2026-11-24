import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalKeyring } from "../approvals/index.js";
import { createInternalApp } from "../routes/internal.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";
import {
  INTERNAL_KEY,
  MCP_VERIFY_KEYS,
  enableConnector,
  mcpToken,
  piName,
  registerConnector,
} from "../testing/mcp-fixtures.js";

/**
 * Two runs of one user at once (KOBE-777, review P2-3): the sandbox's `policy.check` for an MCP
 * tool combines the sandbox's active runs the way the MCP proxy does, so both reach the same
 * decision; where the combination needs approval the member is asked (through the broker), and
 * the proxy then finds the signed approval it requires.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const live = new Set<string>();
let app: ReturnType<typeof createInternalApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    approvalKeys: approvalKeyring("approval-key-for-tests-".padEnd(48, "s")),
    approvals: { pollMs: 100 },
    sandboxWire: { sweep: false, tuning: { batchWindowMs: 20, resultPollMs: 200 } },
  }));
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  app = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: fx.replica(0).deps.mcp,
    auth: {
      db: fx.db,
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
});

interface Run {
  readonly runId: string;
  readonly threadId: string;
}

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sb: FakeSandbox;
  readonly token: string;
  readonly connector: { id: string; name: string };
  /** Thread A's run: the one every call below names. */
  readonly a: Run;
  startRun(): Promise<Run>;
}

async function world(): Promise<World> {
  const owner = await fx.person(`s${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`sr-${randomBytes(3).toString("hex")}`, owner);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const sb = await FakeSandbox.connect(
    must(listeners[0], "listener").url,
    auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const connector = await registerConnector(fx.admin);
  await enableConnector(fx.admin, team, connector.id, owner.id, "all");
  const startRun = async (): Promise<Run> => {
    const runId = await fx.run(team, owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE id = $1`,
      [runId],
    );
    const threadId = must(rows[0], "run").thread_id;
    const started = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: team, userId: owner.id },
        { runId, threadId, message: "hello" },
      );
    expect(started).toEqual({ ok: true });
    return { runId, threadId };
  };
  const a = await startRun();
  const token = mcpToken({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, sb, token, connector, a, startRun };
}

let nextRequest = 0;
function check(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
  const toolCallId = `call-${requestId}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.a.runId,
    thread_id: w.a.threadId,
    tool_call_id: toolCallId,
    tool: piName(w.connector.name, tool),
    input,
  });
  return {
    toolCallId,
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
  };
}

/** The MCP proxy's re-check of the same call (thread A, same tool call id and input). */
async function proxy(w: World, tool: string, input: Record<string, unknown>, toolCallId: string) {
  const res = await app.request(`/internal/v1/mcp/connectors/${w.connector.id}/calls`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INTERNAL_KEY}`,
      "kaiju-sandbox-token": w.token,
    },
    body: JSON.stringify({
      tool,
      thread_id: w.a.threadId,
      tool_call_id: toolCallId,
      arguments: input,
    }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function approve(w: World, approvalId: string) {
  const res = await w.owner.browser.post(`/v1/approvals/${approvalId}`, { decision: "allow" });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function ruleAppliedEvents(w: World): Promise<number> {
  const { rows } = await fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM run_events
      WHERE team_id = $1 AND run_id = $2 AND type = 'policy.rule_applied'`,
    [w.team, w.a.runId],
  );
  return Number(must(rows[0], "count").n);
}

describe("an MCP call with a sibling run in the sandbox", () => {
  it("asks when a stricter sibling run would ask, and the proxy accepts the approval (ac-1)", async () => {
    const w = await world();
    const b = await w.startRun();
    await fx.admin.query(`UPDATE runs SET approval_mode = 'ask-all' WHERE id = $1`, [b.runId]);
    const input = { q: "read it" };
    const call = check(w, "get_issue", input);
    const pending = await call.pending();
    await approve(w, pending.approval_id);
    expect((await call.result()).decision).toBe("allow");
    expect(await proxy(w, "get_issue", input, call.toolCallId)).toMatchObject({
      decision: "allow",
      reason: "approval_granted",
      approval_id: pending.approval_id,
    });
  });

  it("allows without asking where every run allows, on both sides", async () => {
    const w = await world();
    await w.startRun();
    const input = { q: "read it" };
    const call = check(w, "get_issue", input);
    expect((await call.result()).decision).toBe("allow");
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
    expect(await proxy(w, "get_issue", input, call.toolCallId)).toMatchObject({
      decision: "allow",
      reason: "risk_read",
    });
  });

  it("a thread rule with a sibling running asks instead of claiming the rule; alone it allows (ac-2)", async () => {
    const w = await world();
    const tool = piName(w.connector.name, "create_issue");
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope, thread_id)
       VALUES ($1, 'user', $2, 'allow', $3, $2, 'thread', $4)`,
      [w.team, w.owner.id, tool, w.a.threadId],
    );
    const b = await w.startRun();
    const input = { q: "create it" };
    const call = check(w, "create_issue", input);
    const pending = await call.pending();
    // The rule did not decide the call, so the tool card does not say it did.
    expect(await ruleAppliedEvents(w)).toBe(0);
    await approve(w, pending.approval_id);
    expect((await call.result()).decision).toBe("allow");
    expect(await proxy(w, "create_issue", input, call.toolCallId)).toMatchObject({
      decision: "allow",
      reason: "approval_granted",
    });

    // Thread B ends: the remembered rule alone allows again, on both sides, without asking.
    await fx.complete(w.team, b.runId);
    const again = check(w, "create_issue", input);
    expect((await again.result()).decision).toBe("allow");
    expect(await ruleAppliedEvents(w)).toBe(1);
    expect(await proxy(w, "create_issue", input, again.toolCallId)).toMatchObject({
      decision: "allow",
      reason: "user_allow_rule",
    });
  });

  it("a remembered rule that covers every run allows on both sides with a sibling running (ac-2)", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
       VALUES ($1, 'user', $2, 'allow', $3, $2, 'forever')`,
      [w.team, w.owner.id, piName(w.connector.name, "create_issue")],
    );
    await w.startRun();
    const input = { q: "create it" };
    const call = check(w, "create_issue", input);
    expect((await call.result()).decision).toBe("allow");
    expect(await proxy(w, "create_issue", input, call.toolCallId)).toMatchObject({
      decision: "allow",
      reason: "user_allow_rule",
    });
  });
});
