import { describe, expect, it } from "vitest";
import { AddressPolicy } from "./index.js";
import { withTestLoopback } from "./testing.js";

describe("withTestLoopback", () => {
  it("adds loopback for local fake upstreams and otherwise defers to the policy", () => {
    const checker = withTestLoopback(new AddressPolicy({ allowedInternal: ["10.0.5.0/24"] }));
    expect(checker.check("127.0.0.1")).toBe("allowed");
    expect(checker.check("10.0.5.1")).toBe("allowed");
    expect(checker.check("169.254.169.254")).toBe("forbidden");
    expect(checker.checkAll(["127.0.0.1", "10.0.5.1"])).toBe("allowed");
    expect(checker.checkAll(["127.0.0.1", "10.0.6.1"])).toBe("forbidden");
    expect(checker.checkAll([])).toBe("forbidden");
  });
});
