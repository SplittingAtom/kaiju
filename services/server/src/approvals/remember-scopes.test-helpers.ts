// Shared setup for the remember-scopes.*.db.test.ts files
// (split from remember-scopes.db.test.ts, KOBE-725).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { DEFAULT_REMEMBER_LIMITS, type RememberLimits } from "@kobe/protocol";
import { createDb, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./index.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createToolRegistry } from "../policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * KOBE-289 end to end against Postgres and a real WebSocket sandbox: every remember scope is
 * enforced by the server (thread and run ids in evaluate; liveness of the thread and run in the
 * rule source), "until end of today" uses the stored time zone, "only this exact action" pins the
 * stored input, admin limits (team, and the site floor teams can only tighten) decide the choices
 * and apply at once to existing rules, "Approve all waiting" signs and audits each approval, a
 * call a rule allowed is announced and audited naming the rule, revocation is immediate (member
 * and team admin, never across teams), and scheduled and auto runs never use remembered rules.
 */
export const fx = new EventStreamFixture();
export const auth = new FakeSandboxAuth();
export const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
export const sandboxes: FakeSandbox[] = [];
export const extraDbs: KobeDatabase[] = [];
export const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
export const registry = createToolRegistry();
export let siteAdmin: Person;

export interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sandboxId: string;
  readonly sb: FakeSandbox;
}

export interface Run {
  readonly runId: string;
  readonly threadId: string;
}

export async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

export async function world(members: readonly Person[] = []): Promise<World & Run> {
  const owner = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`rs-${randomBytes(3).toString("hex")}`, owner, members);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const w = { team, owner, sandboxId, sb };
  return { ...w, ...(await newRun(w)) };
}

/** A new run: in a new thread, or in `threadId` (after the previous run there ended). */
export async function newRun(w: World, threadId?: string): Promise<Run> {
  let runId: string;
  if (threadId === undefined) {
    runId = await fx.run(w.team, w.owner);
  } else {
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, threadId],
    );
    runId = must(rows[0], "run").id;
  }
  const thread = await threadOf(w.team, runId);
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId, threadId: thread, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { runId, threadId: thread };
}

export async function endRun(w: World, run: Run): Promise<void> {
  await fx.complete(w.team, run.runId);
}

export let nextRequest = 0;
export function check(w: World, run: Run, tool: string, input: Record<string, unknown>) {
  const requestId = `q${(nextRequest += 1)}`;
  const toolCallId = `call-${requestId}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: run.runId,
    thread_id: run.threadId,
    tool_call_id: toolCallId,
    tool,
    input,
  });
  return {
    toolCallId,
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

/** Asks, then answers it with `body`; returns the decision's response. */
export async function approve(
  w: World,
  run: Run,
  tool: string,
  input: Record<string, unknown>,
  body: object,
) {
  const call = check(w, run, tool, input);
  const pending = await call.pending();
  const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, body);
  return { res, call, approvalId: pending.approval_id };
}

/** The decision for one more call: "allow" (no asking) or "ask" (a card) — then answered deny. */
export async function outcome(w: World, run: Run, tool: string, input: Record<string, unknown>) {
  const call = check(w, run, tool, input);
  const first = await w.sb.until(
    () =>
      w.sb.frames("policy.pending").find((f) => f.tool_call_id === call.toolCallId) ??
      w.sb.frames("policy.result").find((f) => f.tool_call_id === call.toolCallId),
  );
  if (first.type === "policy.result") return first.decision;
  await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, { decision: "deny" });
  await call.result();
  return "ask";
}

export const share = (path: string) => ({ path: `/workspace/${path}` });

export async function events(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
    [teamId, runId],
  );
  return rows;
}

export async function audits(teamId: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [teamId, action],
  );
  return rows.map((r) => r.target);
}

export async function rules(teamId: string) {
  const { rows } = await fx.admin.query<{
    id: string;
    remember_scope: string;
    thread_id: string | null;
    run_id: string | null;
    arg_pattern: Record<string, string> | null;
    expires_at: Date | null;
    last_used_at: Date | null;
  }>(
    `SELECT id, remember_scope, thread_id, run_id, arg_pattern, expires_at, last_used_at
       FROM tool_rules WHERE team_id = $1 AND scope = 'user' ORDER BY created_at`,
    [teamId],
  );
  return rows;
}

export const limits = (over: Partial<RememberLimits>): RememberLimits => ({
  ...DEFAULT_REMEMBER_LIMITS,
  ...over,
});

/**
 * Registers the shared hooks; call once at the top level of each
 * remember-scopes.*.db.test.ts file.
 */
export function useRememberScopesWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}], () => {
      const database = createDb(fx.database.appUrl);
      extraDbs.push(database);
      return {
        approvalKeys: KEY,
        approvals: { pollMs: 100 },
        sandboxWire: {
          sweep: false,
          tools: registry,
          engine: createPolicyEngine({
            rules: createDbRuleSource(database.db),
            settings: createDbSettingsSource(database.db, 0),
            registry,
          }),
          tuning: { batchWindowMs: 20, resultPollMs: 200 },
        },
      };
    });
    listeners.push(await sandboxListener(fx.replica(0).deps, auth));
    siteAdmin = await fx.person("siteadmin");
    await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      siteAdmin.id,
    ]);
  });

  afterAll(async () => {
    for (const s of sandboxes) s.close();
    for (const l of listeners) await l.close();
    await fx.teardown();
    for (const d of extraDbs) await d.close();
  });
}
