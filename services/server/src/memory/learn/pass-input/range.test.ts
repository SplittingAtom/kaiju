import { describe, expect, it } from "vitest";
import { learningRange, type PathEntry } from "./range.js";

const T0 = new Date("2026-11-01T00:00:00Z");
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

/** A straight path e1..eN, root first; seq and time grow with the index. */
const path = (n: number, start = 1): PathEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    entryId: `e${start + i}`,
    seq: start + i,
    createdAt: later(start + i),
  }));

describe("no watermark", () => {
  it("reads the whole branch", () => {
    expect(learningRange({ path: path(4), fork: null, watermark: null, rescan: false })).toEqual({
      start: 0,
      mode: "full",
      lowerBound: 0,
    });
  });
});

describe("watermark by entry", () => {
  it("continues after a watermark on the branch", () => {
    const r = learningRange({
      path: path(5),
      fork: null,
      watermark: { entryId: "e3", ancestors: ["e3", "e2", "e1"] },
      rescan: false,
    });
    expect(r).toEqual({ start: 3, mode: "continue", lowerBound: 0 });
  });

  it("rescans from the lowest common ancestor when the watermark is on another branch", () => {
    // e1 - e2 - e3 (leaf branch: e1 e2 e3 e4); the watermark w2 hangs off e2.
    const r = learningRange({
      path: path(4),
      fork: null,
      watermark: { entryId: "w2", ancestors: ["w2", "w1", "e2", "e1"] },
      rescan: false,
    });
    expect(r).toEqual({ start: 2, mode: "lca", lowerBound: 0 });
  });

  it("rescans everything when the watermark shares nothing with the branch", () => {
    const r = learningRange({
      path: path(3),
      fork: null,
      watermark: { entryId: "x", ancestors: ["x"] },
      rescan: false,
    });
    expect(r).toEqual({ start: 0, mode: "lca", lowerBound: 0 });
  });

  it("ignores the watermark on rescan", () => {
    const r = learningRange({
      path: path(5),
      fork: null,
      watermark: { entryId: "e4", ancestors: ["e4", "e3", "e2", "e1"] },
      rescan: true,
    });
    expect(r).toEqual({ start: 0, mode: "rescan", lowerBound: 0 });
  });

  it("has nothing new when the watermark is the leaf", () => {
    const r = learningRange({
      path: path(3),
      fork: null,
      watermark: { entryId: "e3", ancestors: ["e3", "e2", "e1"] },
      rescan: false,
    });
    expect(r.start).toBe(3);
  });
});

describe("fork and copy lower bound (Q9)", () => {
  // Copied e1..e3 (source times, seq 1..3), then the fork's own e4.. after it was created.
  const fork = { forkSeq: 3, threadCreatedAt: later(10) };
  const forked = [...path(3), ...path(2, 4).map((e) => ({ ...e, createdAt: later(10 + e.seq) }))];

  it("never reads the copied prefix", () => {
    expect(learningRange({ path: forked, fork, watermark: null, rescan: false })).toEqual({
      start: 3,
      mode: "full",
      lowerBound: 3,
    });
  });

  it("holds on rescan and when the watermark's common ancestor is copied", () => {
    expect(learningRange({ path: forked, fork, watermark: null, rescan: true }).start).toBe(3);
    const r = learningRange({
      path: forked,
      fork,
      watermark: { entryId: "w", ancestors: ["w", "e1"] },
      rescan: false,
    });
    expect(r.start).toBe(3);
  });

  it("treats an entry older than the fork as copied even if the fork entry is missing", () => {
    const r = learningRange({
      path: forked,
      fork: { forkSeq: null, threadCreatedAt: later(10) },
      watermark: null,
      rescan: false,
    });
    expect(r.start).toBe(3);
  });

  it("holds when the fork's own branch starts from an earlier copied entry", () => {
    // The owner edited the copied e2: the branch is e1 e2 n1 n2 (n* after the fork).
    const edited: PathEntry[] = [
      ...path(2),
      { entryId: "n1", seq: 4, createdAt: later(11) },
      { entryId: "n2", seq: 5, createdAt: later(12) },
    ];
    expect(learningRange({ path: edited, fork, watermark: null, rescan: false }).start).toBe(2);
  });
});
