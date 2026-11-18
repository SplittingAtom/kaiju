// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { LEARN_NUDGE_KEY, claimNudge } from "./learn-nudge";

/** KOBE-410: the Learn nudge pulses once per crossing per thread (its owner), not per render. */
describe("claimNudge", () => {
  beforeEach(() => localStorage.clear());

  it("claims a crossing once, then refuses it; a new crossing claims again", () => {
    expect(claimNudge("t1", "start:messages")).toBe(true);
    expect(claimNudge("t1", "start:messages")).toBe(false);
    expect(localStorage.getItem(`${LEARN_NUDGE_KEY}:t1`)).toBe("start:messages");
    expect(claimNudge("t1", "e9:messages")).toBe(true);
    expect(claimNudge("t2", "start:messages")).toBe(true);
  });

  it("remembers in memory when storage is blocked", () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(claimNudge("t3", "start:correction")).toBe(true);
      expect(claimNudge("t3", "start:correction")).toBe(false);
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });
});
