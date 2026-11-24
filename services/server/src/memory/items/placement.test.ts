import { describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
  runSemanticMemorySchema,
  semanticMemoryRenderedBytes,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
} from "@kaiju/protocol";
import {
  TOOL_ONLY_AVAILABLE,
  applyPlacement,
  effectivePlacement,
  epochIndex,
  markHeld,
} from "./placement.js";

/** KOBE-658: the server side of memory placement (the payload the sandbox renders and records). */
let n = 0;
const item = (over: Partial<RunSemanticMemoryItem> = {}): RunSemanticMemoryItem => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  version: 1,
  scope: "team",
  kind: "fact",
  statement: "A statement.",
  policy: false,
  pinned: false,
  provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
  ...over,
});
const POLICY = item({ scope: "site", kind: "convention", policy: true });
const PINNED = item({ pinned: true });
const A = item({ statement: "A" });
const B = item({ statement: "B" });
const C = item({ statement: "C" });
const block = (items: RunSemanticMemoryItem[], omitted = 0): RunSemanticMemory =>
  runSemanticMemorySchema.parse({ items, omitted_count: omitted });
const valid = (s: RunSemanticMemory) => runSemanticMemorySchema.parse(s);

describe("effectivePlacement", () => {
  it("system for an agent that cannot place picks (an older sandbox image)", () => {
    expect(effectivePlacement("latest_user_keep", { agentPlaces: false })).toBe("system");
    expect(effectivePlacement("stable_plus_delta", { agentPlaces: false })).toBe("system");
  });

  it("the Site's choice otherwise", () => {
    for (const p of [
      "system",
      "latest_user_keep",
      "latest_user_strip",
      "stable_plus_delta",
    ] as const)
      expect(effectivePlacement(p, { agentPlaces: true })).toBe(p);
  });

  it("tool_only falls back to latest_user_keep with a log line until KOBE-399 lands", () => {
    expect(TOOL_ONLY_AVAILABLE).toBe(false);
    const warn = vi.fn();
    expect(effectivePlacement("tool_only", { agentPlaces: true, warn })).toBe("latest_user_keep");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tool_only.*latest_user_keep/));
  });
});

describe("applyPlacement", () => {
  it("system leaves the selection as it was (no placement field: the old shape)", () => {
    const s = block([POLICY, PINNED, A], 2);
    expect(applyPlacement(s, "system", { budgetBytes: 8192 })).toEqual(s);
  });

  it("keep and strip only name the placement", () => {
    const s = block([POLICY, PINNED, A], 2);
    for (const p of ["latest_user_keep", "latest_user_strip"] as const) {
      const out = valid(applyPlacement(s, p, { budgetBytes: 8192 }));
      expect(out).toEqual({ ...s, placement: p });
    }
  });

  it("tool_only drops the picks and counts them as omitted", () => {
    const out = valid(
      applyPlacement(block([POLICY, PINNED, A, B], 1), "tool_only", { budgetBytes: 8192 }),
    );
    expect(out.items.map((i) => i.id)).toEqual([POLICY.id, PINNED.id]);
    expect(out.omitted_count).toBe(3);
  });

  it("stable_plus_delta: the held set first (marked), then only the picks it lacks", () => {
    const out = valid(
      applyPlacement(block([POLICY, PINNED, B, C]), "stable_plus_delta", {
        budgetBytes: 8192,
        held: [A, B],
      }),
    );
    expect(out.placement).toBe("stable_plus_delta");
    expect(out.items.map((i) => [i.statement, i.held === true])).toEqual([
      [POLICY.statement, false],
      [PINNED.statement, false],
      ["A", true],
      ["B", true],
      ["C", false],
    ]);
  });

  it("stable_plus_delta at an epoch start (held undefined): every pick is held", () => {
    const out = valid(
      applyPlacement(block([POLICY, A, B]), "stable_plus_delta", { budgetBytes: 8192 }),
    );
    expect(out.items.filter((i) => i.held === true).map((i) => i.id)).toEqual([A.id, B.id]);
  });

  it("a held item now pinned or Policy stays where it is, never held twice", () => {
    const out = valid(
      applyPlacement(block([POLICY, PINNED, C]), "stable_plus_delta", {
        budgetBytes: 8192,
        held: [{ ...PINNED, pinned: false }, A],
      }),
    );
    expect(out.items.map((i) => i.id)).toEqual([POLICY.id, PINNED.id, A.id, C.id]);
    expect(out.items[1]?.held).toBeUndefined();
  });

  it("stays within the budget: drops picks from the end, then held ones, never Policy or pinned", () => {
    const big = (s: string) => item({ statement: s.repeat(450) });
    const held = [big("h"), big("i"), big("j")];
    const picks = [big("p"), big("q")];
    const budget = SEMANTIC_MEMORY_BLOCK_MIN_BYTES;
    const out = valid(
      applyPlacement(block([POLICY, PINNED, ...picks], 1), "stable_plus_delta", {
        budgetBytes: budget,
        held,
      }),
    );
    expect(semanticMemoryRenderedBytes(out)).toBeLessThanOrEqual(budget);
    expect(out.items.slice(0, 2).map((i) => i.id)).toEqual([POLICY.id, PINNED.id]);
    const kept = out.items.length - 2;
    expect(out.omitted_count).toBe(1 + (5 - kept));
    // The last pick went first; every held one stayed.
    expect(out.items.some((i) => i.statement.startsWith("q"))).toBe(false);
    expect(out.items.filter((i) => i.held === true)).toHaveLength(3);
  });
});

describe("epochIndex", () => {
  it("re-picks every N message runs, counting from the thread's first", () => {
    expect([0, 1, 19, 20, 21, 39, 40].map((k) => epochIndex(k, 20))).toEqual([
      0, 0, 0, 20, 20, 20, 40,
    ]);
  });
});

describe("markHeld (a start delivered again)", () => {
  it("marks the recorded picks that are held and orders them first", () => {
    const out = valid(markHeld(block([POLICY, PINNED, A, B, C]), new Set([C.id, A.id])));
    expect(out.items.map((i) => [i.statement, i.held === true])).toEqual([
      [POLICY.statement, false],
      [PINNED.statement, false],
      ["A", true],
      ["C", true],
      ["B", false],
    ]);
    expect(out.placement).toBe("stable_plus_delta");
  });
});
