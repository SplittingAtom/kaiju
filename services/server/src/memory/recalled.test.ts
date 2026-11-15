import { describe, expect, it } from "vitest";
import { RecalledItems } from "./recalled.js";

describe("RecalledItems (KOBE-399)", () => {
  it("remembers what a run's recall named, per run, and forgets the oldest past the cap", () => {
    const r = new RecalledItems(2);
    r.add("run1", [{ id: "a", scope: "team" }]);
    expect(r.scopeOf("run1", "a")).toBe("team");
    expect(r.scopeOf("run2", "a")).toBeUndefined();
    r.add("run1", [
      { id: "b", scope: "user" },
      { id: "c", scope: "site" },
    ]);
    expect(r.scopeOf("run1", "a")).toBeUndefined();
    expect(r.scopeOf("run1", "b")).toBe("user");
    expect(r.scopeOf("run1", "c")).toBe("site");
  });
});
