import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS as DB_NOTIFICATION_KINDS } from "@kaiju/db";
import { GIT_CONVERSION_FAILURES, NOTIFICATION_KINDS } from "@kaiju/protocol";
import { failureCodeOf } from "./bell.js";
import { FAILURE_MESSAGES } from "./refusals.js";

describe("git bell notices (KOBE-819)", () => {
  it("the database knows the same notification kinds as the contract, in order", () => {
    expect([...DB_NOTIFICATION_KINDS]).toEqual([...NOTIFICATION_KINDS]);
  });

  it("stores a listed failure code as it is and anything else as internal_error", () => {
    for (const code of GIT_CONVERSION_FAILURES) {
      expect(failureCodeOf({ lastError: code })).toBe(code);
      // Every code has member-safe words for the bell.
      expect(FAILURE_MESSAGES[code].length).toBeGreaterThan(0);
    }
    expect(failureCodeOf({ lastError: null })).toBe("internal_error");
    expect(failureCodeOf({ lastError: "something_new" })).toBe("internal_error");
  });
});
