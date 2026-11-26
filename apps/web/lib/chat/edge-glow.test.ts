import { describe, expect, it } from "vitest";
import { edgeGlow, failedNoticeId, waitingReason } from "./edge-glow";
import type { LiveRun } from "./live";
import { initialThreadState, type ThreadState } from "./thread-state";
import type { RunSnapshot, ThreadSummary } from "./types";

/**
 * KOBE-840: which run states make the chat window's edge glow. Every blocked-on-member state of
 * the run state is here: a pending approval (by the server's run status or the live stream), an
 * interrupted run, a paused queue; and a failed run for red.
 */
const T = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";

function ready(over: Partial<ThreadState> = {}): ThreadState {
  return {
    ...initialThreadState(T),
    phase: "ready",
    summary: { threadId: T } as unknown as ThreadSummary,
    ...over,
  };
}

const run = (status: RunSnapshot["status"]): RunSnapshot => ({
  runId: R,
  threadId: T,
  status,
  trigger: "user",
});

const live = (over: Partial<LiveRun> = {}): LiveRun =>
  ({
    runId: R,
    lastSeq: 1,
    started: true,
    committed: [],
    promptCommitted: true,
    tools: {},
    notices: [],
    messages: [],
    ...over,
  }) as unknown as LiveRun;

const failed = live({
  terminal: {
    type: "run.failed",
    run_id: R,
    seq: 9,
    payload: { error: { code: "start_failed", message: "No sandbox." } },
  } as unknown as LiveRun["terminal"],
});

const never = () => false;

describe("waitingReason", () => {
  it("a run waiting for an approval, by the server's status or the stream", () => {
    expect(waitingReason(ready({ runs: [run("waiting_approval")] }))).toBe("approval");
    const asked = live({
      tools: {
        tc1: { approvalRequested: { approval_id: "a" }, approvalResolved: undefined },
      } as unknown as LiveRun["tools"],
    });
    expect(waitingReason(ready({ runs: [run("running")], live: asked }))).toBe("approval");
  });

  it("a running run waits for nobody", () => {
    expect(waitingReason(ready({ runs: [run("running")], live: live() }))).toBeNull();
  });

  it("an interrupted run waits for Retry or Continue", () => {
    expect(waitingReason(ready({ interruptedRun: run("interrupted") }))).toBe("interrupted");
  });

  it("a paused queue with messages waits for Resume or a new message", () => {
    const pending = [{ runId: R, status: "queued" as const, content: "next", parentEntryId: null }];
    expect(waitingReason(ready({ queuePaused: true, pending }))).toBe("queue-paused");
    expect(waitingReason(ready({ queuePaused: true }))).toBeNull();
    expect(waitingReason(ready({ pending }))).toBeNull();
  });
});

describe("edgeGlow", () => {
  it("gold while waiting, red after a failure until closed or a send, none otherwise", () => {
    expect(edgeGlow(ready(), never)).toBeNull();
    expect(edgeGlow(ready({ runs: [run("waiting_approval")] }), never)).toBe("waiting");
    expect(edgeGlow(ready({ live: failed }), never)).toBe("error");
    expect(failedNoticeId(ready({ live: failed }))).toBe(`${R}:9`);
    expect(edgeGlow(ready({ live: failed }), (id) => id === `${R}:9`)).toBeNull();
    const sending = { text: "again", queues: false } as unknown as ThreadState["sending"];
    expect(edgeGlow(ready({ live: failed, sending }), never)).toBeNull();
  });

  it("waiting outranks an older failure", () => {
    expect(edgeGlow(ready({ live: failed, interruptedRun: run("interrupted") }), never)).toBe(
      "waiting",
    );
  });

  it("none for a shared reader, in Trash, a draft or while loading", () => {
    const waiting = { runs: [run("waiting_approval")] };
    const summary = (extra: object) => ({ threadId: T, ...extra }) as unknown as ThreadSummary;
    expect(edgeGlow(ready({ ...waiting, summary: summary({ readOnly: true }) }), never)).toBeNull();
    expect(
      edgeGlow(ready({ ...waiting, summary: summary({ deletedAt: "2026-11-25" }) }), never),
    ).toBeNull();
    expect(edgeGlow({ ...ready(waiting), threadId: null }, never)).toBeNull();
    expect(edgeGlow({ ...ready(waiting), phase: "loading" }, never)).toBeNull();
  });
});
