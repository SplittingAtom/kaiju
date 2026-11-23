import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createDb, pruneExpiredRateLimits, type KobeDatabase } from "@kobe/db";
import { afterAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbMemberRate, MEMBER_RATE_DB } from "./member-rate.js";
import type { CallContext } from "./seams.js";

/**
 * KOBE-810 (ac-2, ac-4): the member per-minute model rate is a bucket in Postgres (GCRA) with the
 * old in-memory bucket's behaviour: a burst of N, refilled at N/60 per second. Two gateway replicas
 * (each its own pool, gate and rate store) share one database and one bucket per member; before,
 * each replica had its own bucket and a member got N per replica. Postgres unreachable: the call
 * is refused (fail closed).
 */
const teamId = randomUUID();
const pools: KobeDatabase[] = [];
const clock = { t: Date.now() };

function replica(
  rpm: number,
  options: { url?: string; now?: () => number; random?: () => number } = {},
): BudgetGate {
  const database = createDb(options.url ?? inject("appUrl"), MEMBER_RATE_DB);
  pools.push(database);
  return new BudgetGate(
    { load: async () => ({ lines: [], requestsPerMinute: rpm }), prices: async () => new Map() },
    {
      ttlMs: 600_000,
      rate: new DbMemberRate(database.db, {
        now: options.now ?? (() => clock.t),
        random: options.random ?? (() => 0),
      }),
    },
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

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe("member per-minute model rate across gateway replicas (KOBE-810)", () => {
  it("two replicas share one bucket: N at once, not N per replica", async () => {
    const [a, b] = [replica(6), replica(6)];
    const member = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? a : b).admit(call(member))),
    );
    expect(decisions.filter((d) => d.ok)).toHaveLength(6);
    for (const d of decisions.filter((x) => !x.ok)) {
      expect(d).toMatchObject({
        status: 429,
        code: "rate_limited",
        message: "Too many model requests for this user; slow down.",
        // One request back after 60/6 = 10 s, not at the end of a minute.
        retryAfterSeconds: 10,
      });
    }
    // Another member of the team has their own bucket.
    expect((await b.admit(call(randomUUID()))).ok).toBe(true);
  });

  it("steady use at exactly N per minute always passes, across both replicas", async () => {
    const [a, b] = [replica(60), replica(60)];
    const member = randomUUID();
    for (let i = 0; i < 180; i += 1) {
      expect((await (i % 2 === 0 ? a : b).admit(call(member))).ok).toBe(true);
      clock.t += 1_000; // 60 per minute
    }
  });

  it("a burst, then a refill at the old rate; Retry-After about 60/N s plus a jitter", async () => {
    const jittered = replica(10, { random: () => 0.99 });
    const plain = replica(10);
    const member = randomUUID();
    for (let i = 0; i < 10; i += 1) expect((await plain.admit(call(member))).ok).toBe(true);
    const refused = await plain.admit(call(member));
    expect(refused).toMatchObject({ ok: false, retryAfterSeconds: 6 });
    // Jitter: up to one interval, at most 1 s.
    expect(await jittered.admit(call(member))).toMatchObject({ ok: false, retryAfterSeconds: 7 });
    clock.t += 5_999;
    expect((await plain.admit(call(member))).ok).toBe(false);
    clock.t += 1;
    expect((await plain.admit(call(member))).ok).toBe(true);
    expect((await plain.admit(call(member))).ok).toBe(false);
    // A minute later the burst is back in full.
    clock.t += 60_000;
    for (let i = 0; i < 10; i += 1) expect((await plain.admit(call(member))).ok).toBe(true);
    expect((await plain.admit(call(member))).ok).toBe(false);
  });

  it("refuses the call when Postgres cannot be reached (fail closed)", async () => {
    const dead = replica(60, { url: "postgres://kobe:x@127.0.0.1:1/none" });
    expect(await dead.admit(call(randomUUID()))).toMatchObject({
      ok: false,
      status: 503,
      code: "rate_limit_unavailable",
    });
  });

  it("costs one upsert per model request (latency measured, with and without the prune)", async () => {
    const real = replica(10_000, { now: () => Date.now() });
    for (let i = 0; i < 10; i += 1) await real.admit(call(randomUUID())); // warm the pool
    const time = async (member: string) => {
      const t = performance.now();
      expect((await real.admit(call(member))).ok).toBe(true);
      return performance.now() - t;
    };
    const quantiles = (samples: number[]) => {
      const s = [...samples].sort((x, y) => x - y);
      const at = (q: number) => (s[Math.floor(q * (s.length - 1))] ?? 0).toFixed(2);
      return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms`;
    };
    const member = randomUUID();
    await time(member);
    const steady: number[] = [];
    for (let i = 0; i < 200; i += 1) steady.push(await time(member));
    // A new member each time: a full bucket (an insert; the prune runs in the background).
    const first: number[] = [];
    for (let i = 0; i < 200; i += 1) first.push(await time(randomUUID()));
    // The prune itself (100 expired rows), which runs at most every 10 s per replica off the path.
    const pool = pools.at(-1);
    if (!pool) throw new Error("no pool");
    const old = Date.now() - 120_000;
    const prune: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      await pool.pool.query(
        `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at)
         SELECT 'kobe:old:' || gen_random_uuid(), 1, $1::bigint, $1::bigint FROM generate_series(1, 100)`,
        [old],
      );
      const t = performance.now();
      expect(await pruneExpiredRateLimits(pool.db, Date.now())).toBeLessThanOrEqual(100);
      prune.push(performance.now() - t);
    }
    console.info(
      `KOBE-810 rate check per model request: steady ${quantiles(steady)}; full bucket ${quantiles(first)}; background prune of 100 rows ${quantiles(prune)}`,
    );
  });
});
