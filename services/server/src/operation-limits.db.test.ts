import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPERATION_LIMITS,
  admitOperation,
  admitSandboxWake,
  type OperationLimit,
} from "./operation-limits.js";
import { SchedulerRunner } from "./scheduler/runner.js";
import { clearLimit, expectRateLimited, fillLimit } from "./testing/operation-limits.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-813: limits on operations that had none. Each limit lets `max` hits through in its window,
 * refuses the next with the time left, and lets hits through again once the window is over. The
 * routes answer the standard 429 with `Retry-After`; schedules firing are never counted or refused.
 */
const f = new RunFixture();

beforeAll(() => f.setup());
afterAll(() => f.teardown());

const db = () => f.fx.replica(0).deps.database.db;

describe("each limit at its boundary (limiter clock)", () => {
  const cases = Object.entries(OPERATION_LIMITS) as [string, OperationLimit][];

  it.each(cases)("%s: max allowed, the next refused, allowed after the window", async (_, rule) => {
    const subject = randomUUID();
    const start = Date.now() - 1_000;
    for (let i = 0; i < rule.max; i += 1) {
      expect((await admitOperation(db(), rule, subject, start + i)).allowed).toBe(true);
    }
    const refused = await admitOperation(db(), rule, subject, start + rule.max);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(Math.ceil((rule.windowMs - rule.max) / 1000));
    const later = await admitOperation(db(), rule, subject, start + rule.windowMs + 1);
    expect(later.allowed).toBe(true);
  });

  it("keeps the values the owner decided", () => {
    const perWindow = Object.fromEntries(
      Object.entries(OPERATION_LIMITS).map(([k, v]) => [k, [v.max, v.windowMs / 60_000]]),
    );
    expect(perWindow).toEqual({
      runSubmit: [60, 1],
      compact: [10, 10],
      branchSummary: [10, 10],
      upload: [120, 10],
      scheduleCreate: [20, 60],
      sandboxWake: [20, 10],
      feedback: [60, 1],
      scimTokenCreate: [10, 60],
      setupAttempt: [10, 10],
    });
  });
});

describe("sandbox wakes the member asks for", () => {
  it("count only when the sandbox is not connected", async () => {
    const owner = { teamId: randomUUID(), userId: randomUUID() };
    const limit = OPERATION_LIMITS.sandboxWake;
    await fillLimit(f.fx.admin, limit, owner.userId);
    const connected = { isConnected: () => Promise.resolve(true) };
    const asleep = { isConnected: () => Promise.resolve(false) };
    expect((await admitSandboxWake(db(), connected, owner)).allowed).toBe(true);
    expect((await admitSandboxWake(db(), asleep, owner)).allowed).toBe(false);
    // A failed check counts as asleep: the limit still applies.
    const broken = { isConnected: () => Promise.reject(new Error("db down")) };
    expect((await admitSandboxWake(db(), broken, owner)).allowed).toBe(false);
  });
});

describe("member routes answer 429 with a retry hint", () => {
  let w: RunWorld;
  let threadId = "";
  beforeAll(async () => {
    w = await f.world();
    threadId = await f.thread(w.owner);
  });

  it("message and Retry share the member's run limit, across conversations", async () => {
    const limit = OPERATION_LIMITS.runSubmit;
    await fillLimit(f.fx.admin, limit, w.owner.id);
    const other = await f.thread(w.owner);
    expectRateLimited(await f.send(w.owner, threadId, "hello"), limit);
    expectRateLimited(await f.send(w.owner, other, "hello"), limit);
    const retry = await f.on(0, w.owner).post(`/v1/runs/${randomUUID()}/retry`, {});
    expectRateLimited(retry, limit);
    const { rows } = await f.fx.admin.query(`SELECT 1 FROM runs WHERE team_id = $1`, [w.team]);
    expect(rows).toHaveLength(0);
    // Once the window is over, Retry gets past the limit again (no such run here).
    await clearLimit(f.fx.admin, limit, w.owner.id);
    const res = await f.on(0, w.owner).post(`/v1/runs/${randomUUID()}/retry`, {});
    expect(res.status).toBe(404);
  });

  it("compaction and branch summary have their own limits", async () => {
    const as = f.on(0, w.owner);
    await fillLimit(f.fx.admin, OPERATION_LIMITS.compact, w.owner.id);
    expectRateLimited(
      await as.post(`/v1/threads/${threadId}/compact`, {}),
      OPERATION_LIMITS.compact,
    );
    await fillLimit(f.fx.admin, OPERATION_LIMITS.branchSummary, w.owner.id);
    expectRateLimited(
      await as.post(`/v1/threads/${threadId}/branch-summary`, { to_entry_id: randomUUID() }),
      OPERATION_LIMITS.branchSummary,
    );
  });

  it("schedule creation", async () => {
    const limit = OPERATION_LIMITS.scheduleCreate;
    await fillLimit(f.fx.admin, limit, w.owner.id);
    const res = await f.on(0, w.owner).post("/v1/schedules", {
      agent_id: randomUUID(),
      prompt: "report",
      recurrence: { kind: "daily", at: "09:00" },
      tz: "UTC",
    });
    expectRateLimited(res, limit);
  });

  it("answer feedback: rating and clearing", async () => {
    const limit = OPERATION_LIMITS.feedback;
    const as = f.on(0, w.owner);
    const run = randomUUID();
    expect((await as.put(`/v1/runs/${run}/feedback`, { rating: "up" })).status).toBe(404);
    await fillLimit(f.fx.admin, limit, w.owner.id);
    expectRateLimited(await as.put(`/v1/runs/${run}/feedback`, { rating: "up" }), limit);
    expectRateLimited(await as.request("DELETE", `/v1/runs/${run}/feedback`), limit);
  });
});

describe("scheduled runs are outside the member's run limit", () => {
  const DUE = new Date("2026-10-10T09:00:00Z");
  const NOW = new Date("2026-10-10T09:20:00Z");

  it("a schedule fires while its owner is at their limit", async () => {
    const w = await f.world();
    const as = f.on(0, w.owner);
    const created = await as.post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Reporter", description: "Reports things" },
      prompt: "You report.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const agentId = created.json.agent.id as string;
    const pub = await as.request("POST", `/v1/agents/${agentId}/publish`, {}, { "if-match": "*" });
    expect(pub.status, JSON.stringify(pub.json)).toBe(201);
    const made = await as.post("/v1/schedules", {
      agent_id: agentId,
      prompt: "daily report",
      recurrence: { kind: "daily", at: "09:00" },
      tz: "UTC",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.schedule_id as string;
    await f.fx.admin.query(`UPDATE schedules SET next_due_at = $1 WHERE id = $2`, [DUE, id]);

    const limit = OPERATION_LIMITS.runSubmit;
    await fillLimit(f.fx.admin, limit, w.owner.id);
    expectRateLimited(await f.send(w.owner, await f.thread(w.owner), "hi"), limit);
    const deps = f.fx.replica(0).deps;
    await new SchedulerRunner({
      db: deps.database.db,
      runs: deps.runs,
      now: () => NOW,
      graceMs: 60 * 60_000,
    }).tick();
    const { rows } = await f.fx.admin.query(
      `SELECT r.id FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE t.schedule_id = $1 AND r.trigger = 'schedule'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    // The scheduled run did not count either: the bucket still holds exactly the limit.
    const bucket = await f.fx.admin.query<{ count: number }>(
      `SELECT count FROM kobe_rate_limits WHERE key = $1`,
      [`kobe:${limit.bucket}:${w.owner.id}`],
    );
    expect(bucket.rows[0]?.count).toBe(limit.max + 1);
  });
});
