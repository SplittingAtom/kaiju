import { describe, expect, it } from "vitest";
import { CHECK_THIS_MIN_RUNS, qualityFlags } from "./flags.js";

const now = new Date("2026-11-18T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe("qualityFlags (KOBE-411)", () => {
  it("check this: more than 30% thumbs-down over at least 10 runs", () => {
    const base = { lastReceivedAt: daysAgo(1), createdAt: daysAgo(200) };
    expect(qualityFlags({ ...base, runs: 10, downRuns: 4 }, 90, now).check_this).toBe(true);
    expect(qualityFlags({ ...base, runs: 10, downRuns: 3 }, 90, now).check_this).toBe(false);
    expect(qualityFlags({ ...base, runs: 9, downRuns: 9 }, 90, now).check_this).toBe(false);
    expect(CHECK_THIS_MIN_RUNS).toBe(10);
  });

  it("unused: not received for the threshold, or never received and older than it", () => {
    const f = (last: string | null, created: string) =>
      qualityFlags(
        { runs: last ? 1 : 0, downRuns: 0, lastReceivedAt: last, createdAt: created },
        90,
        now,
      ).unused;
    expect(f(daysAgo(91), daysAgo(300))).toBe(true);
    expect(f(daysAgo(89), daysAgo(300))).toBe(false);
    expect(f(null, daysAgo(91))).toBe(true);
    expect(f(null, daysAgo(10))).toBe(false);
  });
});
