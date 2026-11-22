import { describe, expect, it } from "vitest";
import { reachesPastRetention } from "./usage-dashboard";

/** KOBE-741: the usage page says when its range starts before the usage the site keeps. */
describe("reachesPastRetention", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const range = (from: string) => ({ from, to: now.toISOString(), bucket: "day" as const });

  it("is true for a range that starts before the kept period", () => {
    expect(
      reachesPastRetention({ range: range("2025-09-01T00:00:00Z"), retentionMonths: 13 }, now),
    ).toBe(true);
  });

  it("is false inside the period, when usage is kept for ever, or from an older server", () => {
    expect(
      reachesPastRetention({ range: range("2026-10-22T00:00:00Z"), retentionMonths: 13 }, now),
    ).toBe(false);
    expect(
      reachesPastRetention({ range: range("2020-01-01T00:00:00Z"), retentionMonths: null }, now),
    ).toBe(false);
    expect(reachesPastRetention({ range: range("2020-01-01T00:00:00Z") }, now)).toBe(false);
  });
});
