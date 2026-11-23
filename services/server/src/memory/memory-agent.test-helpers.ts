// Shared setup for the memory-agent.*.db.test.ts files
// (split from memory-agent.db.test.ts, KOBE-725).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { CAPABILITY_MEMORY, type PolicyEngine } from "@kobe/protocol";
import { memoryResultFrameSchema } from "@kobe/protocol/sandbox-wire";
import { approvalKeyring } from "../approvals/index.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";
import { MemoryObjects } from "../testing/memory-objects.js";

/**
 * KOBE-156 end to end: `memory.put` / `memory.read` from a fake sandbox connection. Accepted only
 * for a connection that announced `memory`, an active leased run, and (put) a `remember` call the
 * server allowed with the same input hash; personal writes apply at once, project writes need a
 * signed approval of exactly that input, switches and membership refuse, `run.start.memory`
 * carries the enabled scopes' indexes, and nothing but ids lands in the audit log.
 */
export const fx = new EventStreamFixture();
export const auth = new FakeSandboxAuth();
export const objects = new MemoryObjects();
export const PREFIX = "kobe/";
export const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
export const sandboxes: FakeSandbox[] = [];
export let listener: Awaited<ReturnType<typeof sandboxListener>>;

/** State each test file owns because its tests assign it; the shared fakes read it here. */
export interface MemoryAgentKnobs {
  /** When true, the policy check itself asks for approval of project writes. */
  askProject(): boolean;
  /** When true, the policy denies `recall` (a deny rule, or the agent's tool list). */
  denyRecall(): boolean;
  /** The file's request id counter (`seq++`), shared with its tests. */
  nextSeq(): number;
}
let knobs: MemoryAgentKnobs;

export const engine: PolicyEngine = {
  decide: (input) => {
    const scope = (input.input as { scope?: string }).scope;
    const reasons = [
      { code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" },
    ];
    if (knobs.denyRecall() && input.tool.name === "recall") {
      return Promise.resolve({
        effect: "deny" as const,
        risk: "read" as const,
        reasons: [{ code: "site_deny_rule" as const, stage: "site_deny" as const, message: "no" }],
      });
    }
    if (knobs.askProject() && input.tool.name === "remember" && scope === "project") {
      return Promise.resolve({
        effect: "require_approval" as const,
        risk: "write" as const,
        reasons,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    return Promise.resolve({ effect: "allow" as const, risk: "write" as const, reasons });
  },
};

export interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

/**
 * KOBE-213: the run becomes a compaction in the database only (this connection's lease still says
 * a message run), so the refusal below can only come from the store's own database check.
 */
export const asCompaction = (team: string, runId: string) =>
  fx.admin.query(
    `UPDATE runs SET kind = 'compaction', input = '', parent_entry_id = NULL, user_entry_id = NULL,
            client_key = NULL, retry_of_run_id = NULL
      WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );

export async function world(): Promise<World> {
  const owner = await fx.person(`m${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`mem-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    runId,
    threadId: must(rows[0], "run").thread_id,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

export async function started(w: World, capabilities: readonly string[] = [CAPABILITY_MEMORY]) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, [], undefined, capabilities);
  await sb.ready();
  const res = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "hi" },
    );
  expect(res).toEqual({ ok: true });
  return sb;
}

/** Puts the world's thread into a new project (rows by SQL: only `join`ed users have rows; every other team member is a reader, KOBE-587). */
export async function inProject(w: World): Promise<string> {
  const id = randomUUID();
  await fx.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
    [w.team, id, `p-${randomBytes(3).toString("hex")}`, w.owner.id],
  );
  await fx.admin.query(`UPDATE threads SET project_id = $3 WHERE team_id = $1 AND id = $2`, [
    w.team,
    w.threadId,
    id,
  ]);
  return id;
}

/** Makes the world's owner an explicit editor of the thread's project (real `project_members`). */
export async function join(w: World, role: "owner" | "editor" = "editor"): Promise<void> {
  await fx.admin.query(
    `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
     SELECT t.team_id, t.project_id, $3, $4, $3 FROM threads t
      WHERE t.team_id = $1 AND t.id = $2 AND t.project_id IS NOT NULL`,
    [w.team, w.threadId, w.owner.id, role],
  );
}

/** The world's owner is a plain member, not a team admin (who acts as owner of every project, PR3). */
export const asPlainMember = (w: World) =>
  fx.admin.query(`UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [
    w.team,
    w.owner.id,
  ]);

export type Input = Record<string, unknown>;

export async function check(
  sb: FakeSandbox,
  w: World,
  callId: string,
  input: Input,
  tool = "remember",
) {
  const request_id = `c${knobs.nextSeq()}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool,
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

export function sendPut(sb: FakeSandbox, w: World, callId: string, input: Input): string {
  const request_id = `p${knobs.nextSeq()}`;
  sb.send({
    v: 1,
    type: "memory.put",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    input,
  });
  return request_id;
}

export async function result(sb: FakeSandbox, requestId: string) {
  const res = await sb.until(
    () => sb.frames("memory.result").find((r) => r.request_id === requestId),
    5000,
  );
  return memoryResultFrameSchema.parse(res) as Record<string, any>;
}

export async function put(sb: FakeSandbox, w: World, callId: string, input: Input) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return result(sb, sendPut(sb, w, callId, input));
}

/** `recall`: the policy check first (the server only reads for an allowed call), then `memory.read`. */
export async function read(
  sb: FakeSandbox,
  w: World,
  input: Input,
  opts: { check?: boolean } = {},
) {
  const callId = `rc${knobs.nextSeq()}`;
  if (opts.check !== false)
    expect((await check(sb, w, callId, input, "recall")).decision).toBe("allow");
  return result(sb, sendRead(sb, w, callId, input));
}

export function sendRead(sb: FakeSandbox, w: World, callId: string, input: Input): string {
  const request_id = `r${knobs.nextSeq()}`;
  sb.send({
    v: 1,
    type: "memory.read",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    input,
  });
  return request_id;
}

export const AUDIT_POLL = { timeout: 5000, interval: 50 };
export const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];
export const docCount = async (team: string) =>
  Number(
    (
      await rows<{ n: string }>(`SELECT count(*) AS n FROM memory_docs WHERE team_id = $1`, [team])
    )[0]?.n,
  );
export const updates = (w: World) =>
  rows<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'memory.updated' ORDER BY seq`,
    [w.team, w.runId],
  );

/**
 * The team's `sandbox.memory_refused` audit rows. They are written off the frame path, so assert
 * on them with `expect.poll(() => refusals(team), AUDIT_POLL)` (KOBE-263: a fixed 300 ms wait
 * lost to a loaded runner).
 */
export async function refusals(team: string): Promise<string[]> {
  return (
    await rows<{ target: { op: string; reason: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.memory_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => `${r.target.op}:${r.target.reason}`);
}

export async function decide(p: Person, approvalId: string, decision: "allow" | "deny") {
  const res = await fx.replica(0).app.request(`http://kobe.test/v1/approvals/${approvalId}`, {
    method: "POST",
    headers: {
      cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      origin: "http://kobe.test",
      "content-type": "application/json",
      "x-forwarded-for": p.browser.ip,
      ...(p.browser.team ? { "x-kobe-team": p.browser.team } : {}),
    },
    body: JSON.stringify({ decision }),
  });
  expect(res.status).toBe(200);
}

export const setTeamSwitches = async (w: World, body: Record<string, boolean>) => {
  const res = await w.owner.browser.put("/v1/memory/settings?level=team", body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

/** Polls an async condition (the sandbox's `until` takes sync predicates only). */
export async function eventually<T>(
  fn: () => Promise<T | undefined | false>,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("eventually timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const errorCode = (r: Record<string, any>) => r.error?.code;

/**
 * Registers the shared hooks; call once at the top level of each
 * memory-agent.*.db.test.ts file.
 */
export function useMemoryAgentWorld(fileKnobs: MemoryAgentKnobs): void {
  knobs = fileKnobs;
  beforeAll(async () => {
    await fx.setup([{}], () => ({
      blobs: { objects, prefix: PREFIX },
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        engine,
        sweep: false,
        tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
      },
    }));
    listener = await sandboxListener(fx.replica(0).deps, auth);
  });

  afterAll(async () => {
    for (const s of sandboxes) s.close();
    await listener.close();
    await fx.teardown();
  });
}
