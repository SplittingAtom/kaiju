import { describe, expect, it } from "vitest";
import { formatMemoryUse, memoryUse, parseExpectations } from "./memory-use.js";

/** KOBE-658: memory use next to the cache share, per placement. */
describe("memoryUse", () => {
  it("counts scored turns whose answer matches any pattern, case-insensitively", () => {
    const expectations = parseExpectations({ expect: [["nrr", "net revenue"], null, ["£"]] });
    const use = memoryUse(expectations, ["Our headline metric is NRR.", "anything", "1.2m"]);
    expect(use).toEqual({ scored: 2, used: 1, share: 0.5, missed: [3] });
  });

  it("a missing answer counts as not used", () => {
    const use = memoryUse(parseExpectations({ expect: [["x"], ["y"]] }), ["x"]);
    expect(use).toMatchObject({ scored: 2, used: 1, missed: [2] });
  });

  it("refuses a bad pattern or shape", () => {
    expect(() => parseExpectations({ expect: [["("]] })).toThrow();
    expect(() => parseExpectations({ expect: "no" })).toThrow();
  });

  it("formats one line", () => {
    expect(formatMemoryUse({ scored: 4, used: 3, share: 0.75, missed: [2] })).toBe(
      "memory use: 3 of 4 scored turns (75.0%); missed turns: 2",
    );
  });
});
