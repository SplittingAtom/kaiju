import { describe, expect, it } from "vitest";
import { MentionStore } from "./mentions";

describe("MentionStore.settleSent (KOBE-415)", () => {
  it("drops the chips that went, keeps those added during the send", () => {
    const store = new MentionStore();
    store.addChip("t", "a.csv");
    store.addChip("t", "b.csv");
    store.addChip("t", "c.csv"); // picked while the message was being sent
    store.settleSent("t", ["a.csv", "b.csv"], "");
    expect(store.chips("t")).toEqual(["c.csv"]);
    store.settleSent("t", ["c.csv"], "");
    expect(store.chips("t")).toEqual([]);
  });
});

describe("MentionStore.restore (KOBE-756: a draft restored from storage)", () => {
  it("puts the kept chips back, refusing what a pick would refuse, and adds no duplicate", () => {
    const store = new MentionStore();
    store.addChip("t", "a.csv");
    store.restore("t", ["a.csv", "b.md", ".kaiju/x", "c​d.txt", "e.txt"]);
    expect(store.chips("t")).toEqual(["a.csv", "b.md", "e.txt"]);
  });

  it("keeps at most 20", () => {
    const store = new MentionStore();
    store.restore(
      "t",
      Array.from({ length: 25 }, (_, i) => `f${i}.txt`),
    );
    expect(store.chips("t")).toHaveLength(20);
  });
});
