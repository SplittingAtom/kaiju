import { describe, expect, it } from "vitest";
import { learnBlocker, learnIndicator, tokensLabel, type LearnState } from "./learn-api";

const base: LearnState = {
  threadId: "11111111-1111-4111-8111-111111111111",
  blocker: null,
  running: null,
  newMessages: false,
  candidates: 0,
  passesLeft: 20,
  lastFailure: null,
  estimate: null,
};

describe("learn indicator (KOBE-395 ac-1)", () => {
  it("prefers running, then the count, then the dot", () => {
    const running = { passId: base.threadId, startedAt: "2026-11-15T10:00:00.000Z" };
    expect(learnIndicator(null)).toEqual({ kind: "none" });
    expect(learnIndicator(base)).toEqual({ kind: "none" });
    expect(learnIndicator({ ...base, newMessages: true })).toEqual({ kind: "new" });
    expect(learnIndicator({ ...base, newMessages: true, candidates: 2 })).toEqual({
      kind: "candidates",
      count: 2,
    });
    expect(learnIndicator({ ...base, candidates: 2, running })).toEqual({ kind: "running" });
  });

  it("shows no dot while Learn can't run", () => {
    const blocker = { code: "memory_disabled" as const, message: "Off." };
    expect(learnIndicator({ ...base, newMessages: true, blocker })).toEqual({ kind: "none" });
  });
});

describe("learn blocker", () => {
  it("names the server's reason, a running pass, and nothing new for /learn only", () => {
    expect(learnBlocker(null, "new")).toMatch(/Checking/);
    expect(
      learnBlocker({ ...base, blocker: { code: "budget_exhausted", message: "B." } }, "all"),
    ).toBe("B.");
    expect(learnBlocker(base, "new")).toMatch(/Nothing new/);
    expect(learnBlocker(base, "all")).toBeNull();
    expect(learnBlocker({ ...base, newMessages: true }, "new")).toBeNull();
  });
});

describe("tokens label", () => {
  it("rounds to a short estimate", () => {
    expect(tokensLabel(900)).toBe("~900 tokens");
    expect(tokensLabel(1_000)).toBe("~1k tokens");
    expect(tokensLabel(1_250)).toBe("~1.3k tokens");
    expect(tokensLabel(18_400)).toBe("~18k tokens");
  });
});
