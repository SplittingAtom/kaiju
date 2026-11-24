// Shared setup for the approvals.*.db.test.ts files (split from approvals.db.test.ts, KOBE-725).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { type ToolDescriptor } from "@kaiju/protocol";
import { createDb, type KaijuDatabase } from "@kaiju/db";
import { approvalKeyring } from "./index.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createToolRegistry } from "../policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * Approvals (KOBE-37, D29) end to end against Postgres, real WebSockets and two replicas: a
 * policy rule makes a tool call wait for its user; allow / deny / remember through the API on the
 * other replica; who may decide; TTL expiry ends the run; Stop, budget and a lost connection
 * expire the approval; the tool call id can't be replayed; and Gate 2 — the MCP proxy's
 * verify-and-consume seam refuses every call a tampered kobe-policy could make without a valid
 * signed approval for exactly that input.
 */
export const fx = new EventStreamFixture();
export const auth = new FakeSandboxAuth();
export const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
export const sandboxes: FakeSandbox[] = [];
export const extraDbs: KaijuDatabase[] = [];
/** A small run event cap so the cap test reaches it (every other test stays far below). */
export const RUN_MAX_EVENTS = 40;
export const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
/**
 * Shifts every approval clock (TTL, token expiry) forward in tests. A file whose tests assign
 * `skewMs` passes `() => skewMs` to useApprovalsWorld.
 */
let skewMs: () => number = () => 0;
export const now = () => new Date(Date.now() + skewMs());

export const CONNECTOR = "55555555-5555-4555-8555-555555555555";
export const mcpTool = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  source: "mcp",
  connector_id: CONNECTOR,
  risk,
  open_world: true,
  scope: "external",
});
export const CATALOG = {
  resolve: (_team: string, name: string) =>
    Promise.resolve(
      name === "mcp__jira__create_issue"
        ? mcpTool(name, "write")
        : name === "mcp__jira__delete_issue"
          ? mcpTool(name, "destructive")
          : undefined,
    ),
};
export const CONNECTORS = {
  get: () =>
    Promise.resolve({
      enabled: true,
      exposure: "all" as const,
      enabled_tools: [],
      drifted_tools: [],
    }),
};
export const registry = createToolRegistry(CATALOG);

export interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

export async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

/** A team, its owner, a running run started on the owner's (fake) sandbox on replica 0. */
export async function world(members: readonly Person[] = []): Promise<World> {
  const owner = await fx.person(`a${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ap-${randomBytes(3).toString("hex")}`, owner, members);
  const runId = await fx.run(team, owner);
  const threadId = await threadOf(team, runId);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(1)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb };
}

export let nextRequest = 0;
export function check(w: World, tool: string, input: Record<string, unknown>, toolCallId?: string) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: toolCallId ?? `call-${requestId}`,
    tool,
    input,
  });
  return {
    requestId,
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

export async function askRule(w: World, toolGlob: string): Promise<void> {
  const res = await w.owner.browser.post("/v1/team/policy/rules", {
    effect: "ask",
    tool_glob: toolGlob,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

export async function decide(p: Person, approvalId: string, body: object, replica = 1) {
  // The decision arrives on the other replica than the one holding the sandbox (bus hint).
  const headers = {
    cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    origin: "http://kaiju.test",
    "content-type": "application/json",
    "x-forwarded-for": p.browser.ip,
    ...(p.browser.team ? { "x-kaiju-team": p.browser.team } : {}),
  };
  const res = await fx
    .replica(replica)
    .app.request(`http://kaiju.test/v1/approvals/${approvalId}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export async function events(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
    [teamId, runId],
  );
  return rows;
}

export async function runStatus(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ status: string }>(
    `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").status;
}

export async function approvalRow(id: string) {
  const { rows } = await fx.admin.query<{
    status: string;
    cause: string | null;
    input_hmac: string | null;
    consumed_at: Date | null;
    remembered: boolean;
  }>(`SELECT status, cause, input_hmac, consumed_at, remembered FROM approvals WHERE id = $1`, [
    id,
  ]);
  return must(rows[0], "approval");
}

export async function audits(teamId: string, prefix: string) {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE $2 ORDER BY seq`,
    [teamId, `${prefix}%`],
  );
  return rows;
}

/** Registers the shared hooks; call once at the top level of each approvals.*.db.test.ts file. */
export function useApprovalsWorld(fileSkewMs: () => number = () => 0): void {
  skewMs = fileSkewMs;
  beforeAll(async () => {
    await fx.setup([{}, {}], () => {
      const database = createDb(fx.database.appUrl);
      extraDbs.push(database);
      return {
        approvalKeys: KEY,
        approvals: { now, pollMs: 100, runMaxEvents: RUN_MAX_EVENTS },
        sandboxWire: {
          sweep: false,
          tools: registry,
          engine: createPolicyEngine({
            rules: createDbRuleSource(database.db),
            settings: createDbSettingsSource(database.db, 0),
            registry,
            connectors: CONNECTORS,
          }),
          tuning: {
            batchWindowMs: 20,
            resultPollMs: 200,
            upgradeBurst: 1_000,
            upgradeRatePerSec: 100,
          },
        },
      };
    });
    listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  });

  afterAll(async () => {
    for (const s of sandboxes) s.close();
    for (const l of listeners) await l.close();
    await fx.teardown();
    for (const d of extraDbs) await d.close();
  });
}
