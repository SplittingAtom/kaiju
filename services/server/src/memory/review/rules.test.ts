import { describe, expect, it } from "vitest";
import { allowedScopes, inSaveAllMine, saveShape, scopeLocked, suggestedScope } from "./rules.js";
import type { StoredCandidate } from "./stored.js";

const TARGET = "11111111-1111-4111-8111-111111111111";
const base: StoredCandidate = {
  statement: "We ship on Tuesdays.",
  kind: "fact",
  destination: "user",
  suggested_scope: "user",
  portable: false,
  project_specific: false,
  source: "stated",
  operation: "add",
  target_id: null,
  confidence: 0.9,
  rationale: "Said so.",
  evidence: [{ entry_id: "u1", quote: "We ship on Tuesdays." }],
  statement_hash: "x",
  warnings: [],
  policy_conflicts: [],
  near_duplicates: [],
};
const c = (over: Partial<StoredCandidate>): StoredCandidate => ({ ...base, ...over });

describe("To review rules (KOBE-396)", () => {
  it("keeps inferred candidates personal, locked", () => {
    const inferred = c({ source: "inferred" });
    expect(allowedScopes(inferred)).toEqual(["user"]);
    expect(allowedScopes(inferred, "preference")).toEqual(["user", "portable"]);
    expect(scopeLocked(inferred)).toBe(true);
  });

  it("offers the Workspace to stated and confirmed candidates, the suggestion first", () => {
    expect(allowedScopes(c({}))).toEqual(["user", "team"]);
    expect(allowedScopes(c({ destination: "team", suggested_scope: "team" }))).toEqual([
      "team",
      "user",
    ]);
    expect(allowedScopes(c({ kind: "preference", destination: "portable" }))).toEqual([
      "portable",
      "user",
      "team",
    ]);
    expect(scopeLocked(c({ source: "confirmed" }))).toBe(false);
  });

  it("keeps project-notes candidates personal until KOBE-398", () => {
    const project = c({ destination: "project_notes", suggested_scope: "team" });
    expect(suggestedScope(project)).toBe("user");
    expect(allowedScopes(project)).toEqual(["user"]);
    expect(inSaveAllMine(project)).toBe(false);
  });

  it("locks a candidate that acts on an item to that item's scope", () => {
    const update = c({ operation: "update", target_id: TARGET });
    expect(allowedScopes(update)).toEqual(["user"]);
    expect(scopeLocked(update)).toBe(true);
    expect(saveShape(update)).toEqual({ op: "update", targetId: TARGET });
    expect(saveShape(c({ operation: "conflict", target_id: TARGET }))).toEqual({
      op: "supersede",
      targetId: TARGET,
    });
    expect(saveShape(c({}))).toEqual({ op: "create" });
  });

  it("puts only new personal memories in Save all mine", () => {
    expect(inSaveAllMine(c({}))).toBe(true);
    expect(inSaveAllMine(c({ kind: "preference", destination: "portable" }))).toBe(true);
    expect(inSaveAllMine(c({ destination: "team" }))).toBe(false);
    expect(inSaveAllMine(c({ operation: "update", target_id: TARGET }))).toBe(false);
  });
});
