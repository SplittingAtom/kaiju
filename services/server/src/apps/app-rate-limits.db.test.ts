import { randomUUID } from "node:crypto";
import {
  createDb,
  returnRateBucketToken,
  takeRateBucket,
  takeRateLimit,
  type KobeDatabase,
} from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hitRateLimit, sharedRateLimit, type RateBucketRule } from "../rate-limit.js";
import { APP_LAUNCH_RATE } from "./app-cards.js";
import { APP_CALL_RATE } from "./call-deps.js";

/**
 * KOBE-810: the MCP App call and card-open limits are refilling buckets in Postgres (GCRA), so two
 * server replicas (two pools, two limiter instances) enforce one bucket per member between them,
 * with the old in-memory buckets' numbers; before, each pod had its own bucket.
 */
let database: TestDatabase;
let replicaA: KobeDatabase;
let replicaB: KobeDatabase;
const clock = { t: Date.now() };

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  replicaA = createDb(database.appUrl, { max: 2 });
  replicaB = createDb(database.appUrl, { max: 2 });
}, 120_000);

afterAll(async () => {
  await replicaA?.close();
  await replicaB?.close();
  await database?.drop();
});

/** Alternates `n` hits over the two replicas at the test clock; how many were admitted. */
async function allowedAcross(name: string, rule: RateBucketRule, user: string, n: number) {
  const a = sharedRateLimit(replicaA.db, name, rule, () => clock.t);
  const b = sharedRateLimit(replicaB.db, name, rule, () => clock.t);
  let allowed = 0;
  for (let i = 0; i < n; i += 1) if (await (i % 2 === 0 ? a : b).allow(user)) allowed += 1;
  return allowed;
}

describe("MCP App limits across server replicas (KOBE-810)", () => {
  it("app tool calls: a burst of 30, then 5 per second, whichever replica serves them", async () => {
    const user = randomUUID();
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 50)).toBe(30);
    clock.t += 199;
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 1)).toBe(0);
    clock.t += 1;
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 2)).toBe(1);
    clock.t += 1_000;
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 10)).toBe(5);
    // Another member has their own bucket.
    expect(await allowedAcross("app-call", APP_CALL_RATE, randomUUID(), 2)).toBe(2);
  });

  it("card opens: a burst of 5, then one every 2 s, whichever replica serves them", async () => {
    const user = randomUUID();
    expect(await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 12)).toBe(5);
    clock.t += 1_999;
    expect(await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 1)).toBe(0);
    clock.t += 1;
    expect(await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 2)).toBe(1);
    // Card opens and app calls are separate buckets.
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 1)).toBe(1);
  });

  it("reset forgets one member's bucket of one limit only", async () => {
    const user = randomUUID();
    await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 6);
    await allowedAcross("app-call", APP_CALL_RATE, user, 31);
    await sharedRateLimit(replicaA.db, "app-launch", APP_LAUNCH_RATE).reset(user);
    expect(await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 1)).toBe(1);
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 1)).toBe(0);
  });

  it("refuses (throws) when Postgres cannot be reached", async () => {
    const dead = createDb("postgres://kobe:x@127.0.0.1:1/none", { max: 1 });
    try {
      await expect(
        sharedRateLimit(dead.db, "app-call", APP_CALL_RATE).allow("u"),
      ).rejects.toThrow();
    } finally {
      await dead.close();
    }
  });
});

describe("replicas whose clocks are 5 minutes apart (KOBE-810)", () => {
  const real = Date.now.bind(Date);
  /** Runs `fn` as a pod whose clock is `skewMs` off. */
  const skewed = async <T>(skewMs: number, fn: () => Promise<T>): Promise<T> => {
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + skewMs);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };

  it("share one bucket: the database clock counts, not the pods'", async () => {
    const ahead = sharedRateLimit(replicaA.db, "app-launch", APP_LAUNCH_RATE);
    const behind = sharedRateLimit(replicaB.db, "app-launch", APP_LAUNCH_RATE);
    const user = randomUUID();
    const answers = [];
    for (let i = 0; i < 8; i += 1) {
      answers.push(
        await (i % 2 === 0
          ? skewed(300_000, () => ahead.allow(user))
          : skewed(0, () => behind.allow(user))),
      );
    }
    // On the pods' clocks the pod behind would refuse everything after the pod ahead's first.
    expect(answers).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("share one fixed window too", async () => {
    const key = `skew:${randomUUID()}`;
    const rule = { windowMs: 60_000, max: 3 };
    const answers = [];
    for (let i = 0; i < 6; i += 1) {
      answers.push(
        await skewed(i % 2 === 0 ? -300_000 : 300_000, () => hitRateLimit(replicaA.db, key, rule)),
      );
    }
    // On the pods' clocks the pod ahead would restart the window and admit a fourth.
    expect(answers).toEqual([true, true, true, false, false, false]);
  });
});

describe("the limiter in @kobe/db (KOBE-810)", () => {
  it("a bucket's refusal says when one request is available, and is not charged", async () => {
    const key = `bucket:${randomUUID()}`;
    const rule = { burst: 2, perSecond: 1 };
    const t0 = clock.t;
    expect((await takeRateBucket(replicaA.db, key, rule, { now: t0 })).allowed).toBe(true);
    expect((await takeRateBucket(replicaB.db, key, rule, { now: t0 })).allowed).toBe(true);
    expect(await takeRateBucket(replicaA.db, key, rule, { now: t0 + 250 })).toEqual({
      allowed: false,
      retryAfterMs: 750,
    });
    // Refusals did not push the time back.
    for (let i = 0; i < 5; i += 1) await takeRateBucket(replicaA.db, key, rule, { now: t0 + 500 });
    expect((await takeRateBucket(replicaB.db, key, rule, { now: t0 + 1_000 })).allowed).toBe(true);
    // A returned request is available at once.
    await returnRateBucketToken(replicaA.db, key, rule);
    expect((await takeRateBucket(replicaA.db, key, rule, { now: t0 + 1_000 })).allowed).toBe(true);
    expect((await takeRateBucket(replicaA.db, key, rule, { now: t0 + 1_000 })).allowed).toBe(false);
  });

  it("works inside a transaction without pruning, and rolls back with it", async () => {
    const key = `tx:${randomUUID()}`;
    const rule = { windowMs: 60_000, max: 1 };
    await replicaA.db
      .transaction(async (tx) => {
        expect((await takeRateLimit(tx, key, rule, { prune: false })).allowed).toBe(true);
        throw new Error("roll back");
      })
      .catch(() => undefined);
    expect((await takeRateLimit(replicaA.db, key, rule)).count).toBe(1);
  });

  it("the fixed window reports the time left in it", async () => {
    const key = `take:${randomUUID()}`;
    const rule = { windowMs: 60_000, max: 1 };
    const t0 = clock.t;
    expect(await takeRateLimit(replicaA.db, key, rule, { now: t0 })).toMatchObject({
      allowed: true,
      count: 1,
      windowStart: t0,
    });
    expect(await takeRateLimit(replicaB.db, key, rule, { now: t0 + 15_000 })).toMatchObject({
      allowed: false,
      count: 2,
      retryAfterMs: 45_000,
    });
  });
});
