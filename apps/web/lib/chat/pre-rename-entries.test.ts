/** KOBE-827: entries written before the rename keep their old custom types; they read the same. */
import { beforeEach, describe, expect, it } from "vitest";
import { isSkippedSummary, parseEntry } from "./entries";
import {
  appCardEntry,
  assistant,
  branchMarker,
  entry,
  resetEntrySeq,
  skippedSummary,
  text,
  user,
} from "./testing/entries";
import { projectTree } from "./tree-nodes";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

/** The same entry as written before the rename (`kaiju.x` → `kobe.x`). */
const old = (e: ThreadEntry): ThreadEntry => ({
  ...e,
  payload: {
    ...e.payload,
    customType: String(e.payload.customType).replace(/^kaiju\./u, "kobe."),
  },
});

describe("entries from before the rename (KOBE-827)", () => {
  it("reads an old app card and an old skipped-actions summary like new ones", () => {
    const card = appCardEntry("ka-0123456789abcdef01234567", "a1");
    expect(old(card).payload.customType).toBe("kobe.app_card");
    expect(parseEntry(old(card))).toEqual(parseEntry(card));
    expect(parseEntry(old(card)).kind).toBe("appCard");

    const summary = skippedSummary("ks-1", "a1", "Skipped 1 action", 1);
    expect(old(summary).payload.customType).toBe("kobe.skipped_actions");
    expect(isSkippedSummary(old(summary))).toBe(true);
    expect(parseEntry(old(summary))).toEqual(parseEntry(summary));
  });

  it("treats an old kobe.branch marker as a branch marker in the conversation tree", () => {
    const entries = (marker: ThreadEntry) => [
      entry("r0", null, null, "thinking_level_change"),
      user("u1", "r0", "first"),
      assistant("a1", "u1", text("one")),
      marker,
    ];
    const current = projectTree(entries(branchMarker("k1", "r0")), "k1", "k1", null);
    resetEntrySeq();
    const before = projectTree(entries(old(branchMarker("k1", "r0"))), "k1", "k1", null);
    expect(before.nodes).toEqual(current.nodes);
    expect(before.nodes.some((n) => n.id === "empty:k1")).toBe(true);
  });

  it("does not take another type for a marker", () => {
    const other = { ...branchMarker("k1", "r0"), payload: { customType: "evil.branch" } };
    const tree = projectTree(
      [
        entry("r0", null, null, "thinking_level_change"),
        user("u1", "r0", "first"),
        other as ThreadEntry,
      ],
      "u1",
      "u1",
      null,
    );
    expect(tree.nodes.some((n) => n.id === "empty:k1")).toBe(false);
  });
});
