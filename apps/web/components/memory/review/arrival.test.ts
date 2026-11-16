// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_HREF, announcePassCompleted, arrivalFor, useReviewArrival } from "./arrival";
import { diffWords } from "./statement-diff";

/** KOBE-396 ac-1: To review opens by itself only on the pass's thread with no other panel. */
const T = "00000000-0000-4000-8000-0000000000aa";
const pass = { threadId: T, passId: "p1", candidates: 3 };

afterEach(cleanup);

describe("arrival of a finished pass", () => {
  it("opens on the thread with nothing else open, waits otherwise", () => {
    expect(arrivalFor(pass, { threadId: T, panelOpen: false })).toBe("open");
    expect(arrivalFor(pass, { threadId: T, panelOpen: true })).toBe("wait");
    expect(arrivalFor(pass, { threadId: "other", panelOpen: false })).toBe("wait");
    expect(arrivalFor(pass, { threadId: undefined, panelOpen: false })).toBe("wait");
    expect(arrivalFor({ ...pass, candidates: 0 }, { threadId: T, panelOpen: false })).toBe("none");
  });

  it("opens To review and marks the bell notice seen, or leaves it for the bell and +", () => {
    const open = vi.fn();
    const seen = vi.fn();
    const onWait = vi.fn();
    const { rerender } = renderHook(
      (p: { panelOpen: boolean }) =>
        useReviewArrival({ threadId: T, panelOpen: p.panelOpen, open, seen, onWait }),
      { initialProps: { panelOpen: false } },
    );
    announcePassCompleted(pass);
    expect(open).toHaveBeenCalledWith(REVIEW_HREF);
    expect(seen).toHaveBeenCalledWith(T);
    rerender({ panelOpen: true });
    announcePassCompleted({ ...pass, passId: "p2" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith({ ...pass, passId: "p2" });
  });
});

describe("statement diff", () => {
  it("marks removed and added words", () => {
    expect(diffWords("We ship on Mondays", "We ship on Tuesdays")).toEqual([
      { kind: "same", text: "We ship on " },
      { kind: "removed", text: "Mondays" },
      { kind: "added", text: "Tuesdays" },
    ]);
  });
});

describe("To review links", () => {
  it("opens Memories (To review on top) for ?tab=review and ?review=", async () => {
    const { isReviewLink, memoryTabOf } = await import("../../../lib/memory/tabs");
    expect(isReviewLink("?tab=review")).toBe(true);
    expect(memoryTabOf("?tab=review")).toBe("memories");
    expect(isReviewLink("?review=1&thread=x")).toBe(true);
    expect(isReviewLink("?tab=notes")).toBe(false);
    expect(memoryTabOf("?tab=notes")).toBe("notes");
  });
});
