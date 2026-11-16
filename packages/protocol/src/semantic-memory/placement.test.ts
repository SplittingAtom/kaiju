import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SEMANTIC_MEMORY_PLACEMENT,
  SEMANTIC_MEMORY_PLACEMENTS,
  SEMANTIC_MEMORY_PLACEMENT_DEFAULT,
  runSemanticMemorySchema,
  semanticMemoryRenderedBytes,
  semanticMemoryRunFence,
} from "../index.js";

type RunItem = Record<string, unknown> & { policy: boolean; pinned: boolean; scope: string };
const runItems = (): [RunItem, RunItem, RunItem, RunItem] => {
  const doc = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "run-start-semantic.json"), "utf8"),
  ) as { memory: { semantic: { items: [RunItem, RunItem, RunItem, RunItem] } } };
  return structuredClone(doc.memory.semantic.items);
};
const parse = (v: Record<string, unknown>) =>
  runSemanticMemorySchema.safeParse({ omitted_count: 0, ...v });

describe("memory placement (KOBE-658)", () => {
  it("names five modes, latest_user_keep by default, and the agent capability", () => {
    expect(SEMANTIC_MEMORY_PLACEMENTS).toEqual([
      "system",
      "latest_user_keep",
      "latest_user_strip",
      "stable_plus_delta",
      "tool_only",
    ]);
    expect(SEMANTIC_MEMORY_PLACEMENT_DEFAULT).toBe("latest_user_keep");
    expect(CAPABILITY_SEMANTIC_MEMORY_PLACEMENT).toBe("semantic_memory_placement");
  });

  it("is additive: absent placement and held still validate (system)", () => {
    const items = runItems();
    expect(parse({ items }).success).toBe(true);
    for (const placement of SEMANTIC_MEMORY_PLACEMENTS.filter((p) => p !== "tool_only")) {
      expect(parse({ items, placement }).success, placement).toBe(true);
    }
    expect(parse({ items, placement: "elsewhere" }).success).toBe(false);
  });

  it("held marks only per-message picks, and only with stable_plus_delta", () => {
    const [policy, pinned, pick, pick2] = runItems();
    const held = { ...pick, held: true };
    expect(
      parse({ items: [policy, pinned, held, pick2], placement: "stable_plus_delta" }).success,
    ).toBe(true);
    expect(
      parse({ items: [policy, pinned, held, pick2], placement: "latest_user_keep" }).success,
    ).toBe(false);
    expect(parse({ items: [policy, pinned, held, pick2] }).success).toBe(false);
    expect(
      parse({ items: [{ ...policy, held: true }], placement: "stable_plus_delta" }).success,
    ).toBe(false);
    expect(
      parse({ items: [{ ...pinned, held: true }], placement: "stable_plus_delta" }).success,
    ).toBe(false);
    expect(
      parse({ items: [{ ...pick, held: false }], placement: "stable_plus_delta" }).success,
    ).toBe(false);
  });

  it("held picks come before the other picks", () => {
    const [policy, , pick, pick2] = runItems();
    const ok = parse({
      items: [policy, { ...pick, held: true }, pick2],
      placement: "stable_plus_delta",
    });
    expect(ok.success).toBe(true);
    const bad = parse({
      items: [policy, pick, { ...pick2, held: true }],
      placement: "stable_plus_delta",
    });
    expect(bad.success).toBe(false);
  });

  it("tool_only carries no per-message picks (Policy and pinned only)", () => {
    const [policy, pinned, pick] = runItems();
    expect(parse({ items: [policy, pinned], placement: "tool_only" }).success).toBe(true);
    expect(parse({ items: [policy, pinned, pick], placement: "tool_only" }).success).toBe(false);
  });

  it("charges a held pick its own fence (it renders in the system prompt)", () => {
    const [, , pick] = runItems();
    const item = pick as unknown as { policy: boolean; pinned: boolean; scope: string };
    expect(semanticMemoryRunFence(item)).toBe(`${pick.scope}:pick`);
    expect(semanticMemoryRunFence({ ...item, held: true })).toBe(`${pick.scope}:held`);
    const [, , a, b] = runItems();
    const same = { ...b, scope: a.scope, kind: a.kind, provenance: a.provenance };
    const plain = semanticMemoryRenderedBytes({ items: [a, same] as never });
    const split = semanticMemoryRenderedBytes({ items: [{ ...a, held: true }, same] as never });
    expect(split).toBeGreaterThan(plain);
  });
});
