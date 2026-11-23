// Shared setup for the sandbox-wire.*.db.test.ts files
// (split from sandbox-wire.db.test.ts, KOBE-725).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * Sandbox connection registry and routing (KOBE-24) against a real Postgres, real WebSockets and
 * two server replicas on one database: routing across replicas, durable cursor (duplicates, gaps,
 * reconnect + resume), leasing, late frames, cross-team isolation, a compromised sandbox, policy
 * checks, interrupted runs.
 */
export const fx = new EventStreamFixture();
export const auth = new FakeSandboxAuth();
export const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
export const ended: { runId: string; status: string }[] = [];
export const woken: string[] = [];
export const sandboxes: FakeSandbox[] = [];

export const url = (replica: number) => must(listeners[replica], "listener").url;

export interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
  readonly target: { teamId: string; userId: string };
}

export async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

export async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`w-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const threadId = await threadOf(team, runId);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  return {
    team,
    owner,
    runId,
    threadId,
    sandboxId,
    token,
    target: { teamId: team, userId: owner.id },
  };
}

export async function newRun(w: World): Promise<{ runId: string; threadId: string }> {
  const runId = await fx.run(w.team, w.owner);
  return { runId, threadId: await threadOf(w.team, runId) };
}

export async function connect(
  replica: number,
  w: World,
  runs: { run_id: string; thread_id: string; last_seq: number }[] = [],
): Promise<FakeSandbox> {
  const sb = await FakeSandbox.connect(url(replica), w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, runs);
  await sb.ready();
  return sb;
}

/** Connects and starts `w.runId` on the sandbox through the other replica's router. */
export async function started(w: World, holder = 0, requester = 1): Promise<FakeSandbox> {
  const sb = await connect(holder, w);
  const result = await fx.replica(requester).deps.sandboxWire.router.startRun(w.target, {
    runId: w.runId,
    threadId: w.threadId,
    message: "hello",
  });
  expect(result).toEqual({ ok: true });
  return sb;
}

export async function events(
  teamId: string,
  runId: string,
): Promise<{ seq: number; type: string; payload: Record<string, unknown> }[]> {
  const { rows } = await fx.admin.query<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>(`SELECT seq, type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`, [
    teamId,
    runId,
  ]);
  return rows;
}

export async function runRow(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ status: string; sandbox_seq: number }>(
    `SELECT status, sandbox_seq FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run");
}

export const delta = (text: string) => ({
  type: "message_update",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
});
export const assistantStart = { type: "message_start", message: { role: "assistant" } };
export const assistantEnd = { type: "message_end", message: { role: "assistant" } };

/** Waits for both replicas' off-path work (audit rows of refused tokens and violations). */
export const settled = () =>
  Promise.all([0, 1].map((i) => fx.replica(i).deps.background.idle())).then(() => undefined);

export async function auditActions(teamId: string): Promise<string[]> {
  const { rows } = await fx.admin.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE team_id = $1 ORDER BY seq`,
    [teamId],
  );
  return rows.map((r) => r.action);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Registers the shared hooks; call once at the top level of each
 * sandbox-wire.*.db.test.ts file.
 */
export function useSandboxWireWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}, {}], () => ({
      sandboxWire: {
        sweep: false,
        tuning: {
          batchWindowMs: 20,
          resultPollMs: 200,
          lostGraceMs: 0,
          helloTimeoutMs: 1_000,
          frameBurst: 400,
          frameRatePerSec: 100,
          // Every test connects from 127.0.0.1, so they all share one upgrade bucket; the production
          // limit (20, refilling 2/s) throttles the suite on slower CI runners.
          upgradeBurst: 1_000,
          upgradeRatePerSec: 100,
        },
        hooks: { onRunEnded: (e) => void ended.push({ runId: e.runId, status: e.status }) },
        waker: { wake: (t) => Promise.resolve(void woken.push(t.userId)) },
      },
    }));
    listeners.push(await sandboxListener(fx.replica(0).deps, auth));
    listeners.push(await sandboxListener(fx.replica(1).deps, auth));
  });

  afterAll(async () => {
    for (const s of sandboxes) s.close();
    for (const l of listeners) await l.close();
    await fx.teardown();
  });
}
