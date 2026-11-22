import { describe, expect, it } from "vitest";
import { RequestRate } from "./limits.js";

describe("RequestRate bucket map (KOBE-810)", () => {
  it("prunes idle buckets when full: an active sandbox keeps its spent bucket (no global reset)", () => {
    const now = { t: 0 };
    const rate = new RequestRate({ burst: 2, perSecond: 1, maxSandboxes: 3 }, () => now.t);
    // A hot sandbox spends its burst.
    expect(rate.allow("hot")).toBe(true);
    expect(rate.allow("hot")).toBe(true);
    expect(rate.allow("hot")).toBe(false);
    // Two sandboxes make one request each, then go idle and refill.
    rate.allow("idle-1");
    rate.allow("idle-2");
    expect(rate.size).toBe(3);
    now.t += 1_100; // the idle buckets are full again; hot has 1.1 tokens
    expect(rate.allow("hot")).toBe(true); // hot: 0.1 left
    // A new sandbox arrives at the cap: the idle (full) buckets go, hot stays.
    expect(rate.allow("new")).toBe(true);
    expect(rate.size).toBe(2);
    expect(rate.allow("hot")).toBe(false);
  });

  it("drops the least recently used active bucket when none is idle", () => {
    const now = { t: 0 };
    const rate = new RequestRate({ burst: 5, perSecond: 0.001, maxSandboxes: 2 }, () => now.t);
    rate.allow("a");
    rate.allow("b");
    rate.allow("a"); // a is now the most recent
    rate.allow("c");
    expect(rate.size).toBe(2);
    // b was dropped (starts afresh with a full burst); a kept its count.
    for (let i = 0; i < 3; i += 1) expect(rate.allow("a")).toBe(true);
    expect(rate.allow("a")).toBe(false);
  });
});
