import { randomUUID } from "node:crypto";
import { createDb, returnRateLimitHit, takeRateLimit, type KobeDatabase } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sharedRateLimit, type RateLimitRule } from "../rate-limit.js";
import { APP_LAUNCH_RATE } from "./app-cards.js";
import { APP_CALL_RATE } from "./call-deps.js";

/**
 * KOBE-810: the MCP App call and card-open limits are counted in Postgres, so two server replicas
 * (two pools, two limiter instances) enforce one limit per member between them; before, each pod
 * had its own bucket and a member got the limit once per replica.
 */
let database: TestDatabase;
let replicaA: KobeDatabase;
let replicaB: KobeDatabase;

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

/** Alternates hits over the two replicas; how many were allowed. */
async function allowedAcross(name: string, rule: RateLimitRule, user: string, n: number) {
  const a = sharedRateLimit(replicaA.db, name, rule);
  const b = sharedRateLimit(replicaB.db, name, rule);
  let allowed = 0;
  for (let i = 0; i < n; i += 1) if (await (i % 2 === 0 ? a : b).allow(user)) allowed += 1;
  return allowed;
}

describe("MCP App limits across server replicas (KOBE-810)", () => {
  it("app tool calls: 30 per member per window, whichever replica serves them", async () => {
    const user = randomUUID();
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 50)).toBe(APP_CALL_RATE.max);
    // Another member has their own window.
    expect(await allowedAcross("app-call", APP_CALL_RATE, randomUUID(), 2)).toBe(2);
  });

  it("card opens: 5 per member per window, whichever replica serves them", async () => {
    const user = randomUUID();
    expect(await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 12)).toBe(APP_LAUNCH_RATE.max);
    // Card opens and app calls are separate counters.
    expect(await allowedAcross("app-call", APP_CALL_RATE, user, 1)).toBe(1);
  });

  it("reset forgets only its own limit's counters", async () => {
    const user = randomUUID();
    await allowedAcross("app-launch", APP_LAUNCH_RATE, user, 6);
    await allowedAcross("app-call", APP_CALL_RATE, user, 31);
    await sharedRateLimit(replicaA.db, "app-launch", APP_LAUNCH_RATE).reset();
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

describe("takeRateLimit reports the window (KOBE-810)", () => {
  it("says how long until the window ends, and takes back a returned hit", async () => {
    const key = `take:${randomUUID()}`;
    const rule = { windowMs: 60_000, max: 1 };
    const t0 = Date.now();
    const first = await takeRateLimit(replicaA.db, key, rule, { now: t0 });
    expect(first).toMatchObject({ allowed: true, count: 1, windowStart: t0 });
    const second = await takeRateLimit(replicaB.db, key, rule, { now: t0 + 15_000 });
    expect(second).toMatchObject({ allowed: false, count: 2, retryAfterMs: 45_000 });
    await returnRateLimitHit(replicaA.db, key, second.windowStart);
    // Back to one hit: still at the limit.
    expect(await takeRateLimit(replicaA.db, key, rule, { now: t0 + 20_000 })).toMatchObject({
      allowed: false,
      count: 2,
    });
    // A returned hit of an older window does not touch the new one.
    const next = await takeRateLimit(replicaA.db, key, rule, { now: t0 + 61_000 });
    expect(next).toMatchObject({ allowed: true, count: 1 });
    await returnRateLimitHit(replicaA.db, key, t0);
    expect((await takeRateLimit(replicaA.db, key, rule, { now: t0 + 62_000 })).count).toBe(2);
  });
});
