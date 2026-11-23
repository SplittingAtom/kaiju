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
  leaseRun,
  mcpToken,
  piName,
  registerConnector,
} from "../testing/mcp-fixtures.js";

/**
 * An agent's `tools.allow` on every call (KOBE-776): the server refuses a call outside the run's
 * agent version's allow list (`agent_tool_deny`) at both enforcement points, the sandbox's
 * `policy.check` and the MCP proxy's re-check; an agent without an allow list is not narrowed.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const live = new Set<string>();
let app: ReturnType<typeof createInternalApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    approvalKeys: approvalKeyring("approval-key-for-tests-".padEnd(48, "t")),
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

interface Base {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
}

async function base(): Promise<Base> {
  const owner = await fx.person(`a${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ta-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  return { team, owner, runId, threadId: must(rows[0], "run").thread_id };
}

/** Creates and publishes an agent as the owner, and pins the run (and its thread) to it. */
async function pin(
  w: Base,
  scope: "team" | "personal",
  frontmatter: Record<string, unknown>,
  options: { readonly draft?: boolean } = {},
): Promise<string> {
  const created = await w.owner.browser.post("/v1/agents", {
    scope,
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt: "Do it.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const published = await w.owner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  await fx.admin.query(
    `UPDATE threads SET agent_scope = $2, agent_id = $3, agent_version = 1 WHERE id = $1`,
    [w.threadId, scope, id],
  );
  await fx.admin.query(`UPDATE runs SET agent_version = $2 WHERE id = $1`, [
    w.runId,
    options.draft ? null : 1,
  ]);
  return id;
}

describe("the sandbox's policy.check", () => {
  interface Wired extends Base {
    readonly sb: FakeSandbox;
  }

  async function wired(): Promise<Wired> {
    const w = await base();
    const sandboxId = randomUUID();
    const token = auth.issue({ sandboxId, teamId: w.team, userId: w.owner.id });
    const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
    if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
    sandboxes.push(sb);
    sb.hello(sandboxId);
    await sb.ready();
    const started = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: w.team, userId: w.owner.id },
        { runId: w.runId, threadId: w.threadId, message: "hello" },
      );
    expect(started).toEqual({ ok: true });
    return { ...w, sb };
  }

  let nextRequest = 0;
  async function check(w: Wired, tool: string, input: Record<string, unknown>) {
    const requestId = `r${(nextRequest += 1)}`;
    w.sb.send({
      v: 1,
      type: "policy.check",
      request_id: requestId,
      run_id: w.runId,
      thread_id: w.threadId,
      tool_call_id: `call-${requestId}`,
      tool,
      input,
    });
    return w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId));
  }

  async function deniedEvents(w: Wired): Promise<string[]> {
    const { rows } = await fx.admin.query<{ code: string }>(
      `SELECT payload->'reasons'->0->>'code' AS code FROM run_events
        WHERE team_id = $1 AND run_id = $2 AND type = 'policy.denied' ORDER BY seq`,
      [w.team, w.runId],
    );
    return rows.map((r) => r.code);
  }

  it("refuses a built-in outside a published team agent's allow list, recorded like any denial", async () => {
    const w = await wired();
    await pin(w, "team", { tools: { allow: ["read", "bash:ls *"] } });
    const outside = await check(w, "ls", {});
    expect(outside.decision).toBe("deny");
    expect(outside.reasons[0]).toMatchObject({ code: "agent_tool_deny", stage: "team_deny" });
    // An argument shorthand narrows the tool to that argument.
    expect((await check(w, "bash", { command: "rm -rf x" })).decision).toBe("deny");
    expect((await check(w, "read", { path: "a.txt" })).decision).toBe("allow");
    expect(await deniedEvents(w)).toEqual(["agent_tool_deny", "agent_tool_deny"]);
  });

  it("refuses it for a personal agent's version and a draft's test chat too", async () => {
    const personal = await wired();
    await pin(personal, "personal", { tools: { allow: ["read"] } });
    expect((await check(personal, "ls", {})).reasons[0]?.code).toBe("agent_tool_deny");

    const draft = await wired();
    await pin(draft, "team", { tools: { allow: ["read"] } }, { draft: true });
    expect((await check(draft, "ls", {})).reasons[0]?.code).toBe("agent_tool_deny");
    expect((await check(draft, "read", { path: "a.txt" })).decision).toBe("allow");
  });

  it("a list naming no built-in leaves built-ins alone (owner decision)", async () => {
    const w = await wired();
    await pin(w, "team", { tools: { allow: ["mcp__jira__search"] } });
    expect((await check(w, "ls", {})).decision).toBe("allow");
    expect((await check(w, "read", { path: "a.txt" })).decision).toBe("allow");
  });

  it("a test chat: an empty draft list narrows nothing; a malformed one refuses every call", async () => {
    const empty = await wired();
    const agentId = await pin(empty, "team", { tools: { deny: ["write"] } }, { draft: true });
    await fx.admin.query(
      `UPDATE team_agents SET frontmatter = jsonb_set(frontmatter, '{tools,allow}', '[]') WHERE id = $1`,
      [agentId],
    );
    expect((await check(empty, "ls", {})).decision).toBe("allow");

    const bad = await wired();
    const badId = await pin(bad, "team", { tools: { deny: ["write"] } }, { draft: true });
    await fx.admin.query(
      `UPDATE team_agents SET frontmatter = jsonb_set(frontmatter, '{tools,allow}', '[1, 2]') WHERE id = $1`,
      [badId],
    );
    const refused = await check(bad, "ls", {});
    expect(refused.decision).toBe("deny");
    expect(refused.reasons[0]?.code).toBe("policy_error");
  });

  it("does not narrow an agent without an allow list", async () => {
    const w = await wired();
    await pin(w, "team", { tools: { deny: ["write"] } });
    expect((await check(w, "ls", {})).decision).toBe("allow");
  });
});

describe("the MCP proxy's re-check", () => {
  async function proxied(allow: readonly string[] | undefined) {
    const w = await base();
    const sandboxId = randomUUID();
    live.add(sandboxId);
    await leaseRun(fx.admin, w.team, w.runId, w.owner.id, sandboxId);
    const connector = await registerConnector(fx.admin);
    await enableConnector(fx.admin, w.team, connector.id, w.owner.id, "all");
    await pin(w, "team", {
      connectors: [connector.name],
      ...(allow === undefined ? {} : { tools: { allow } }),
    });
    const token = mcpToken({ sandboxId, teamId: w.team, userId: w.owner.id });
    const call = async (tool: string) => {
      const res = await app.request(`/internal/v1/mcp/connectors/${connector.id}/calls`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${INTERNAL_KEY}`,
          "kobe-sandbox-token": token,
        },
        body: JSON.stringify({ tool, thread_id: w.threadId, arguments: { q: "x" } }),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    return { ...w, connector, call };
  }

  it("refuses an MCP tool outside the allow list, and audits the refusal", async () => {
    const w = await proxied(["read", "mcp__*__create_issue"]);
    expect(await w.call("get_issue")).toMatchObject({ decision: "deny", code: "agent_tool_deny" });
    const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'mcp.tool_call' ORDER BY seq`,
      [w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([
      expect.objectContaining({
        tool: piName(w.connector.name, "get_issue"),
        decision: "denied",
        reason: "agent_tool_deny",
      }),
    ]);
  });

  it("a list naming only connector tools still limits connector tools", async () => {
    const w = await proxied(["mcp__*__create_issue"]);
    expect(await w.call("get_issue")).toMatchObject({ decision: "deny", code: "agent_tool_deny" });
  });

  it("allows a listed MCP tool, by name or glob, and leaves an agent without a list alone", async () => {
    const named = await proxied(["read", "mcp__*__get_issue"]);
    expect(await named.call("get_issue")).toMatchObject({ decision: "allow" });
    const open = await proxied(undefined);
    expect(await open.call("get_issue")).toMatchObject({ decision: "allow" });
  });
});
