import {
  SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES,
  runSemanticMemorySchema,
  semanticMemoryRenderedBytes,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
  type SemanticMemoryPlacement,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { MARKER_BEGIN, MARKER_END } from "../kobe-tools/memory-fence.js";
import {
  HELD_HEADER,
  KNOWN_HEADER,
  PICKS_HEADER,
  preamble,
  semanticContextText,
} from "./semantic-context.js";

/** KOBE-658: where the per-message picks render, per Site setting `memory.placement`. */
const NONCE = "0123456789abcdef";
let n = 0;
const item = (over: Partial<RunSemanticMemoryItem> = {}): RunSemanticMemoryItem => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  version: 1,
  scope: "team",
  kind: "fact",
  statement: "The staging cluster is k3s.",
  policy: false,
  pinned: false,
  provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
  ...over,
});
const POLICY = item({ scope: "site", kind: "convention", policy: true, statement: "POLICY-1" });
const PINNED = item({ pinned: true, statement: "PINNED-TEAM" });
const PICK_A = item({ scope: "user", kind: "preference", statement: "PICK-A" });
const PICK_B = item({ statement: "PICK-B" });
const block = (
  items: RunSemanticMemoryItem[],
  placement?: SemanticMemoryPlacement,
  omitted_count = 0,
): RunSemanticMemory =>
  runSemanticMemorySchema.parse({
    items,
    omitted_count,
    ...(placement === undefined ? {} : { placement }),
  });

describe("memory placement in the render (KOBE-658)", () => {
  it("system (and absent): picks stay a second part, the preamble as KOBE-383 built it", () => {
    const absent = semanticContextText(block([POLICY, PINNED, PICK_A]), NONCE, { recall: true });
    const system = semanticContextText(block([POLICY, PINNED, PICK_A], "system"), NONCE, {
      recall: true,
    });
    expect(system).toEqual(absent);
    expect(system.placement).toBe("system");
    expect(system.known).toContain(preamble(NONCE));
    expect(system.picks.startsWith(`${PICKS_HEADER}\n`)).toBe(true);
    expect(system.held).toBe("");
  });

  it.each(["latest_user_keep", "latest_user_strip"] as const)(
    "%s: Policy and pinned in the stable part, picks in their own part, the preamble says where blocks count",
    (placement) => {
      const r = semanticContextText(block([POLICY, PINNED, PICK_A, PICK_B], placement), NONCE, {
        recall: true,
      });
      expect(r.placement).toBe(placement);
      expect(r.known).toContain("POLICY-1");
      expect(r.known).toContain("PINNED-TEAM");
      expect(r.known).not.toContain("PICK-");
      expect(r.picks).toContain("PICK-A");
      expect(r.picks).toContain("PICK-B");
      expect(r.held).toBe("");
      const lead = preamble(NONCE, placement);
      expect(r.known).toContain(lead);
      expect(lead).not.toBe(preamble(NONCE));
      expect(lead).toMatch(/before a person's message/);
      expect(lead).toMatch(/organization policy appears only in the system prompt/i);
    },
  );

  it("stable_plus_delta: held picks render in the system prompt part, the rest per message", () => {
    const held = { ...PICK_A, held: true as const };
    const r = semanticContextText(
      block([POLICY, PINNED, held, PICK_B], "stable_plus_delta"),
      NONCE,
      {
        recall: true,
      },
    );
    expect(r.held.startsWith(`${HELD_HEADER}\n`)).toBe(true);
    expect(r.held).toContain("PICK-A");
    expect(r.held).not.toContain("PICK-B");
    expect(r.picks).toContain("PICK-B");
    expect(r.picks).not.toContain("PICK-A");
    expect(r.heldSections.map((s) => s.text).join("\n")).toBe(r.held);
    expect(r.held.split(MARKER_BEGIN).length).toBe(r.held.split(MARKER_END).length);
  });

  it("tool_only: no picks part at all, Policy and pinned stay", () => {
    const r = semanticContextText(block([POLICY, PINNED], "tool_only", 4), NONCE, {
      recall: true,
    });
    expect(r.known).toContain("POLICY-1");
    expect(r.picks).toContain("4 more saved memories not shown");
    expect(r.held).toBe("");
  });

  it("the stable part is byte-identical when only the picks change (every mode but system)", () => {
    for (const placement of [
      "latest_user_keep",
      "latest_user_strip",
      "stable_plus_delta",
    ] as const) {
      const one = semanticContextText(block([POLICY, PINNED, PICK_A], placement), NONCE, {
        recall: true,
      });
      const two = semanticContextText(block([POLICY, PINNED, PICK_B], placement), NONCE, {
        recall: true,
      });
      expect(two.known, placement).toBe(one.known);
      expect(two.held, placement).toBe(one.held);
      expect(two.picks, placement).not.toBe(one.picks);
    }
  });

  it("the cap counts every part, dropping per-message picks before held ones, never Policy", () => {
    const s = "q".repeat(400);
    const held = Array.from({ length: 5 }, () => item({ statement: s, held: true as const }));
    const picks = Array.from({ length: 5 }, () => item({ scope: "user", statement: s }));
    const b = block([POLICY, ...held, ...picks], "stable_plus_delta");
    const r = semanticContextText(b, NONCE, { recall: true, maxBytes: 4096 });
    expect(r.dropped).toBeGreaterThan(0);
    const size =
      Buffer.byteLength(r.known) + Buffer.byteLength(r.held) + Buffer.byteLength(r.picks);
    expect(size).toBeLessThanOrEqual(4096);
    expect(r.known).toContain("POLICY-1");
    expect(r.held.split("- fact:").length - 1).toBe(5);
  });

  it("never renders more than the server counts, in every mode", () => {
    for (const placement of [
      "latest_user_keep",
      "latest_user_strip",
      "stable_plus_delta",
    ] as const) {
      const s = (k: number) => "s".repeat(k);
      const pickHeld = placement === "stable_plus_delta" ? { held: true as const } : {};
      const items = [
        item({ scope: "site", policy: true, statement: s(500) }),
        item({ scope: "site", pinned: true, statement: s(500) }),
        item({ scope: "site", statement: s(500), ...pickHeld }),
        item({ statement: s(500), ...pickHeld }),
        item({ statement: s(300) }),
        item({ scope: "portable", kind: "preference", statement: s(500) }),
        item({ scope: "user", kind: "preference", statement: s(500) }),
      ];
      const b = block(items, placement, 4);
      const r = semanticContextText(b, NONCE, {
        recall: true,
        maxBytes: semanticMemoryRenderedBytes(b),
      });
      expect(r.dropped, placement).toBe(0);
      const size =
        Buffer.byteLength(r.known) + Buffer.byteLength(r.held) + Buffer.byteLength(r.picks);
      expect(size, placement).toBeLessThanOrEqual(semanticMemoryRenderedBytes(b));
    }
  });

  it("headers, preamble and overflow stay within the block overhead in every mode", () => {
    for (const placement of ["latest_user_keep", "stable_plus_delta"] as const) {
      const r = semanticContextText(block([POLICY], placement, 99_999), NONCE, { recall: true });
      const fence = r.known.slice(r.known.indexOf(MARKER_BEGIN));
      const overhead =
        Buffer.byteLength(r.known) -
        Buffer.byteLength(fence) +
        Buffer.byteLength(r.picks) +
        Buffer.byteLength(`${HELD_HEADER}\n`);
      expect(overhead, placement).toBeLessThanOrEqual(SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES);
    }
  });

  it("each part has exactly one header line", () => {
    const held = { ...PICK_A, held: true as const };
    const r = semanticContextText(block([POLICY, held, PICK_B], "stable_plus_delta"), NONCE, {
      recall: true,
    });
    expect(r.known.split("\n").filter((l) => l.startsWith("## "))).toEqual([KNOWN_HEADER]);
    expect(r.held.split("\n").filter((l) => l.startsWith("## "))).toEqual([HELD_HEADER]);
    expect(r.picks.split("\n").filter((l) => l.startsWith("## "))).toEqual([PICKS_HEADER]);
  });
});
