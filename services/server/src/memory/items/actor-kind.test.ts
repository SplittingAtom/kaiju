import { describe, expect, it } from "vitest";
import { presentedActorKind } from "./actor-kind.js";

describe("presentedActorKind (KOBE-403)", () => {
  it("shows a proposal-made version as set by the Site and leaves the others", () => {
    expect(presentedActorKind("proposal")).toBe("user");
    for (const k of ["user", "import", "pass"] as const) expect(presentedActorKind(k)).toBe(k);
  });
});
