import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createDb, type KobeDatabase } from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbMemberRate } from "./member-rate.js";
import type { CallContext } from "./seams.js";

/**
 * KOBE-810 (ac-2, ac-4): the member per-minute model rate is counted in Postgres. Two gateway
 * replicas (each its own pool, gate and rate store) share one database and together admit the
 * admin's number per member per minute; before, each replica had its own bucket and a member got
 * the number once per replica. Postgres unreachable: the call is refused (fail closed).
 */
const RPM = 6;
const teamId = randomUUID();
const pools: KobeDatabase[] = [];

function replica(url: string, rpm = RPM): BudgetGate {
  const database = createDb(url, { max: 2 });
  pools.push(database);
  return new BudgetGate(
    { load: async () => ({ lines: [], requestsPerMinute: rpm }), prices: async () => new Map() },
    { ttlMs: 60_000, rate: new DbMemberRate(database.db) },
  );
}

const call = (userId: string): CallContext => ({
  teamId,
  userId,
  sandboxId: randomUUID(),
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: "openai/m",
});

let a: BudgetGate;
let b: BudgetGate;

beforeAll(() => {
  a = replica(inject("appUrl"));
  b = replica(inject("appUrl"));
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe("member per-minute model rate across gateway replicas (KOBE-810)", () => {
  it("two replicas sharing the database admit the per-minute value once, not once each", async () => {
    const member = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: 3 * RPM }, (_, i) => (i % 2 === 0 ? a : b).admit(call(member))),
    );
    expect(decisions.filter((d) => d.ok)).toHaveLength(RPM);
    const refused = decisions.filter((d) => !d.ok);
    for (const d of refused) {
      expect(d).toMatchObject({
        status: 429,
        code: "rate_limited",
        message: "Too many model requests for this user; slow down.",
      });
      // Seconds until the member's minute ends.
      expect(d.ok === false && d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(d.ok === false && d.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    // Another member of the team has their own minute.
    expect((await b.admit(call(randomUUID()))).ok).toBe(true);
  });

  it("refuses the call when Postgres cannot be reached (fail closed)", async () => {
    const dead = replica("postgres://kobe:x@127.0.0.1:1/none");
    expect(await dead.admit(call(randomUUID()))).toMatchObject({
      ok: false,
      status: 503,
      code: "rate_limit_unavailable",
    });
  });

  it("costs one upsert per model request (latency measured)", async () => {
    const fast = replica(inject("appUrl"), 10_000);
    const member = randomUUID();
    for (let i = 0; i < 10; i += 1) await fast.admit(call(member)); // warm the pool
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = performance.now();
      expect((await fast.admit(call(member))).ok).toBe(true);
      samples.push(performance.now() - t);
    }
    samples.sort((x, y) => x - y);
    const at = (q: number) => (samples[Math.floor(q * (samples.length - 1))] ?? 0).toFixed(2);
    console.info(`KOBE-810 rate check per model request: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms`);
  });
});
