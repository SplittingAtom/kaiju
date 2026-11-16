import { describe, expect, it } from "vitest";
import type { LearnState } from "./learn-api";
import { LEARN_SPIN_MAX_MS, learnStep } from "./learn-watch";

/** KOBE-661: the + button's watch over a pass it started, one read of the Learn state at a time. */
const base: LearnState = {
  threadId: "t1",
  blocker: null,
  running: null,
  newMessages: false,
  candidates: 0,
  passesLeft: 19,
  lastFailure: null,
  estimate: null,
};
const running = (passId: string, over: Partial<LearnState> = {}): LearnState => ({
  ...base,
  running: { passId, startedAt: "2026-11-16T18:00:00.000Z" },
  ...over,
});
const T0 = 1_000_000;
const watch = { passId: "p1", since: T0 };

describe("learnStep", () => {
  it("nothing watched and nothing running: idle, the state as read", () => {
    expect(learnStep(null, { ...base, candidates: 2 }, T0)).toEqual({
      kind: "idle",
      state: { ...base, candidates: 2 },
    });
  });

  it("a running pass this tab did not start (another tab, a reload) is watched from now", () => {
    expect(learnStep(null, running("p9"), T0)).toMatchObject({
      kind: "running",
      watch: { passId: "p9", since: T0 },
    });
  });

  it("the watched pass still runs: keep spinning, the watch unchanged", () => {
    const step = learnStep(watch, running("p1"), T0 + 4_000);
    expect(step).toMatchObject({ kind: "running", watch });
    expect(step.state.running?.passId).toBe("p1");
  });

  it("the watched pass completed: ended with the candidates, no failure", () => {
    const step = learnStep(watch, { ...base, candidates: 1 }, T0 + 2_000);
    expect(step).toEqual({
      kind: "ended",
      passId: "p1",
      failure: null,
      state: { ...base, candidates: 1 },
    });
  });

  it("the watched pass failed: ended with the server's sentence", () => {
    const lastFailure = { passId: "p1", message: "Try again.", finishedAt: "x" };
    expect(learnStep(watch, { ...base, lastFailure }, T0 + 2_000)).toMatchObject({
      kind: "ended",
      failure: "Try again.",
    });
  });

  it("an older failure is not this pass's", () => {
    const lastFailure = { passId: "p0", message: "old", finishedAt: "x" };
    expect(learnStep(watch, { ...base, lastFailure }, T0)).toMatchObject({
      kind: "ended",
      failure: null,
    });
  });

  it("another pass runs now: the watched one ended, the state shows the new one", () => {
    const step = learnStep(watch, running("p2"), T0 + 2_000);
    expect(step).toMatchObject({ kind: "ended", passId: "p1" });
    expect(step.state.running?.passId).toBe("p2");
  });

  it("never spins forever: past the limit it times out and shows nothing running", () => {
    expect(learnStep(watch, running("p1"), T0 + LEARN_SPIN_MAX_MS).kind).toBe("running");
    const step = learnStep(watch, running("p1"), T0 + LEARN_SPIN_MAX_MS + 1);
    expect(step).toMatchObject({ kind: "timeout", passId: "p1" });
    expect(step.state.running).toBeNull();
  });

  it("a pass given up on does not bring the spinner back", () => {
    const step = learnStep(null, running("p1", { candidates: 3 }), T0, new Set(["p1"]));
    expect(step).toEqual({ kind: "idle", state: { ...base, candidates: 3 } });
  });
});
