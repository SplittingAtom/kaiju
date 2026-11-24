import { describe, expect, it } from "vitest";
import type { KaijuEvent } from "@kaiju/protocol";
import { newLiveRun } from "../live";
import { initialThreadState, type ThreadState } from "../thread-state";
import type { RunSnapshot, ThreadSummary } from "../types";
import { MAX_REOPEN_ATTEMPTS, planAfterClose, planSignal, planTerminal } from "./after-close";
import { historyOf, liveFileRequest, withPending, withRuns } from "./history";
import { planRegenerate, REGENERATE_NOT_SENT, restoreFailure } from "./model-restore";
import { queueOrder, queuePositionsOf, withQueuePositions } from "./queue";

const ok = (status: RunSnapshot["status"]) => ({
  ok: true as const,
  status: 200,
  data: { status },
});
const delay = (n: number) => 1000 * 2 ** n;
const run = (runId: string, status: RunSnapshot["status"], extra: Partial<RunSnapshot> = {}) =>
  ({ runId, threadId: "t", status, trigger: "user", ...extra }) as RunSnapshot;
const state = (change: Partial<ThreadState> = {}): ThreadState => ({
  ...initialThreadState("t"),
  ...change,
});

describe("planAfterClose", () => {
  it("re-reads the history when the run ended (the entries are the record)", () => {
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      expect(planAfterClose(ok(status), 0, delay)).toEqual({ kind: "refresh" });
    }
  });

  it("re-reads when the run went back to the queue (the next one is promoted by the read)", () => {
    expect(planAfterClose(ok("queued"), 3, delay)).toEqual({ kind: "refresh" });
  });

  it("reopens a still active run with backoff, then gives up", () => {
    expect(planAfterClose(ok("running"), 0, delay)).toEqual({
      kind: "reopen",
      delayMs: 1000,
      attempts: 1,
    });
    expect(planAfterClose(ok("waiting_approval"), 2, delay)).toEqual({
      kind: "reopen",
      delayMs: 4000,
      attempts: 3,
    });
    expect(planAfterClose(ok("running"), MAX_REOPEN_ATTEMPTS, delay)).toEqual({ kind: "lost" });
  });

  it("is lost, with the error, when the run cannot be read", () => {
    const error = { status: 503, code: "unavailable", message: "Try again." };
    expect(planAfterClose({ ok: false, error }, 0, delay)).toEqual({ kind: "lost", error });
  });
});

describe("planSignal", () => {
  const live = newLiveRun("r1");
  const streams = { streamRunId: "r1", epilogueRunId: undefined, live };

  it("follows the streamed run's connection", () => {
    expect(planSignal("r1", { kind: "open" }, streams)).toEqual({ kind: "open" });
    expect(planSignal("r1", { kind: "reconnecting" }, streams)).toEqual({ kind: "reconnecting" });
    expect(planSignal("r1", { kind: "closed" }, streams)).toEqual({ kind: "closed" });
  });

  it("ignores other runs' signals but still hears their close", () => {
    expect(planSignal("r0", { kind: "open" }, streams)).toEqual({ kind: "ignore" });
    expect(planSignal("r0", { kind: "closed" }, streams)).toEqual({ kind: "closed" });
  });

  it("asks nothing after the run's terminal event", () => {
    const ended = { ...live, terminal: { type: "run.failed" } } as unknown as typeof live;
    expect(planSignal("r1", { kind: "closed" }, { ...streams, live: ended })).toEqual({
      kind: "closed_after_terminal",
    });
  });

  it("lets an epilogue stream end quietly", () => {
    const epilogue = { streamRunId: "r2", epilogueRunId: "r1", live };
    expect(planSignal("r1", { kind: "open" }, epilogue)).toEqual({ kind: "ignore" });
    expect(planSignal("r1", { kind: "closed" }, epilogue)).toEqual({ kind: "epilogue_closed" });
  });
});

describe("planTerminal", () => {
  type Terminal = Parameters<typeof planTerminal>[0];
  const terminal = (type: string, payload: object) => ({ type, payload }) as unknown as Terminal;

  it("moves the leaf to a completed run's answer and keeps an announced epilogue open", () => {
    expect(planTerminal(terminal("run.completed", { leaf_entry_id: "e9" }))).toEqual({
      announcement: "The agent finished.",
      leaf: "e9",
      keepEpilogue: false,
    });
    expect(
      planTerminal(terminal("run.completed", { leaf_entry_id: null, epilogue: ["title"] })),
    ).toEqual({ announcement: "The agent finished.", keepEpilogue: true });
  });

  it("offers a retry after a lost sandbox; never moves the leaf otherwise", () => {
    expect(planTerminal(terminal("run.interrupted", { reason: "sandbox_lost" }))).toEqual({
      announcement: "The run was interrupted. You can retry it.",
      keepEpilogue: false,
    });
    expect(planTerminal(terminal("run.interrupted", { reason: "cancelled" })).announcement).toBe(
      "The run was stopped.",
    );
    expect(planTerminal(terminal("run.budget_stopped", {})).leaf).toBeUndefined();
  });
});

describe("model restore", () => {
  const summary = { threadId: "t", model: "k2" } as unknown as ThreadSummary;
  const ready = state({ phase: "ready", summary });

  it("switches only to another model, and remembers the one to put back", () => {
    expect(planRegenerate(ready, "qwen")).toEqual({ previous: "k2", switching: true });
    expect(planRegenerate(ready, "k2")).toEqual({ previous: "k2", switching: false });
    const teamDefault = { ...ready, summary: { ...summary, model: null } };
    expect(planRegenerate(teamDefault, null)).toEqual({
      previous: null,
      switching: false,
    });
  });

  it("refuses while another choice is on its way", () => {
    expect(planRegenerate({ ...ready, busy: ["model"] }, "qwen")).toBeUndefined();
  });

  it("keeps the send's failure in the banner, else says the model was not changed", () => {
    const failed = { error: { status: 409, code: "thread_busy", message: "Busy." } };
    expect(restoreFailure({ ...ready, actionError: failed })).toBe(failed);
    expect(restoreFailure(ready)).toEqual({ error: REGENERATE_NOT_SENT });
  });
});

describe("queue planners", () => {
  it("keeps retries first in a new order", () => {
    const runs = [
      run("a", "queued"),
      run("b", "queued", { retryOfRunId: "x" }),
      run("c", "queued"),
    ];
    expect(queueOrder(runs, ["c", "a", "b"])).toEqual(["b", "c", "a"]);
  });

  it("shows the server's positions on the pending messages", () => {
    const pending = [
      { runId: "a", status: "queued", content: "A", parentEntryId: null, queuePos: 1 },
      { runId: "b", status: "queued", content: "B", parentEntryId: null, queuePos: 2 },
    ] as unknown as ThreadState["pending"];
    const positions = queuePositionsOf([
      run("a", "queued", { queuePos: 2 }),
      run("b", "queued", { queuePos: 1 }),
      run("r", "running"),
    ]);
    expect([...positions]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    const next = withQueuePositions(state({ pending }), positions);
    expect(next.pending.map((m) => m.queuePos)).toEqual([2, 1]);
  });
});

describe("history planners", () => {
  it("holds the queue's pause until a run starts or the queue empties", () => {
    const paused = state({ queuePaused: true });
    expect(withRuns(paused, { runs: [run("q", "queued")], interruptedRun: null }).queuePaused).toBe(
      true,
    );
    expect(
      withRuns(paused, { runs: [run("r", "running")], interruptedRun: null }).queuePaused,
    ).toBe(false);
    expect(
      withRuns(paused, { runs: [run("q", "queued")], interruptedRun: null, queuePaused: false })
        .queuePaused,
    ).toBe(false);
  });

  it("takes the live run's prompt from its pending message, keeping the sent files", () => {
    const files = [{ name: "a.csv", mimeType: "text/csv" }] as never;
    const s = state({
      live: newLiveRun("r1"),
      livePrompt: { text: "old", parentEntryId: null, files },
    });
    const next = withPending(s, [
      { runId: "r1", status: "running", content: "Hello", parentEntryId: "e1" },
    ] as never);
    expect(next.livePrompt).toEqual({ text: "Hello", parentEntryId: "e1", files });
  });

  it("counts nothing as history for a run this tab started; else the server's last seq", () => {
    const s = { runs: [run("r1", "running", { lastSeq: 7 })], interruptedRun: null };
    expect(historyOf(s, new Set(["r1"]), "r1", 3)).toBe(0);
    expect(historyOf(s, new Set(), "r1", 3)).toBe(7);
    expect(historyOf(s, new Set(), "r1", 9)).toBe(9);
    expect(historyOf(s, new Set(), "r2", 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("opens only live file events above the history", () => {
    const opened = (seq: number, path: string) =>
      ({
        run_id: "r1",
        seq,
        ts: "2026-01-01T00:00:00Z",
        type: "file.opened",
        payload: { tool_call_id: `c${seq}`, path },
      }) as unknown as KaijuEvent;
    const events = [opened(4, "a.md"), opened(6, "b.md")];
    expect(liveFileRequest("file.opened", "r1", 0, 5, events)).toEqual({
      runId: "r1",
      toolCallId: "c6",
      path: "b.md",
    });
    expect(liveFileRequest("file.opened", "r1", 6, 0, events)).toBeUndefined();
    expect(liveFileRequest("file.opened", "r1", 0, undefined, events)).toBeUndefined();
  });
});
