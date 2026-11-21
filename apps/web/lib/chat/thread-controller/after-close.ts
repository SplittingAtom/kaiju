/**
 * What a thread controller does when a run's stream signals or ends (pure planners, KOBE-716):
 * state in, the next action out. `ThreadController` carries the action out (timers, reads).
 */
import { isTerminalRunStatus } from "@kobe/protocol";
import type { ApiError, ApiResult } from "../../api/client";
import type { StreamSignal } from "../stream";
import { isThreadRunning, type ThreadState } from "../thread-state";
import type { RunSnapshot } from "../types";

export const MAX_REOPEN_ATTEMPTS = 5;

/** After the server ended or refused a stream before its terminal event. */
export type AfterClosePlan =
  /** The run could not be read (`error`), or the reopen attempts ran out (no error). */
  | { readonly kind: "lost"; readonly error?: ApiError | undefined }
  /** Ended or queued again: the entries are the record, so the thread is read again. */
  | { readonly kind: "refresh" }
  /** Still active: the stream reopens after `delayMs`; `attempts` is the new count. */
  | { readonly kind: "reopen"; readonly delayMs: number; readonly attempts: number };

export function planAfterClose(
  run: ApiResult<Pick<RunSnapshot, "status">>,
  reopenAttempts: number,
  reopenDelay: (attempt: number) => number,
): AfterClosePlan {
  if (!run.ok) return { kind: "lost", error: run.error };
  // Ended (204 on reconnect, or 410: events compacted), or back in the queue.
  if (isTerminalRunStatus(run.data.status) || run.data.status === "queued") {
    return { kind: "refresh" };
  }
  if (reopenAttempts >= MAX_REOPEN_ATTEMPTS) return { kind: "lost" };
  return { kind: "reopen", delayMs: reopenDelay(reopenAttempts), attempts: reopenAttempts + 1 };
}

/** A stream signal for `runId`, given which runs the controller streams now. */
export type SignalPlan =
  /** Not this controller's concern (another run's stream, or an epilogue still open). */
  | { readonly kind: "ignore" }
  /** The epilogue's stream ended (all results arrived, or the window closed). */
  | { readonly kind: "epilogue_closed" }
  | { readonly kind: "open" }
  | { readonly kind: "reconnecting" }
  /** The stream closed after the run's terminal event: nothing more to ask. */
  | { readonly kind: "closed_after_terminal" }
  /** The stream closed before a terminal event: ask the server what the run is doing. */
  | { readonly kind: "closed" };

export interface StreamsNow {
  readonly streamRunId: string | undefined;
  readonly epilogueRunId: string | undefined;
  readonly live: ThreadState["live"];
}

export function planSignal(runId: string, signal: StreamSignal, now: StreamsNow): SignalPlan {
  if (now.epilogueRunId === runId && now.streamRunId !== runId) {
    return signal.kind === "closed" ? { kind: "epilogue_closed" } : { kind: "ignore" };
  }
  if (now.streamRunId !== runId && signal.kind !== "closed") return { kind: "ignore" };
  if (signal.kind === "open") return { kind: "open" };
  if (signal.kind === "reconnecting") return { kind: "reconnecting" };
  if (now.live?.runId === runId && now.live.terminal !== undefined) {
    return { kind: "closed_after_terminal" };
  }
  return { kind: "closed" };
}

type Terminal = NonNullable<NonNullable<ThreadState["live"]>["terminal"]>;

const TERMINAL_MESSAGES: Record<Terminal["type"], string> = {
  "run.completed": "The agent finished.",
  "run.failed": "The run failed.",
  "run.interrupted": "The run was stopped.",
  "run.budget_stopped": "The run stopped: the budget is used up.",
};

/** What a run's terminal event changes: the line announced, a leaf move, an epilogue kept open. */
export interface TerminalPlan {
  readonly announcement: string;
  /** The run's own answer is the new leaf; its follow-ups arrive after it, so they are kept. */
  readonly leaf?: string | undefined;
  /** A `run.completed` that announces an epilogue: its stream stays open for the results. */
  readonly keepEpilogue: boolean;
}

export function planTerminal(terminal: Terminal): TerminalPlan {
  let announcement = TERMINAL_MESSAGES[terminal.type];
  if (terminal.type === "run.interrupted" && terminal.payload.reason === "sandbox_lost") {
    announcement = "The run was interrupted. You can retry it.";
  }
  if (terminal.type !== "run.completed") return { announcement, keepEpilogue: false };
  const leaf = terminal.payload.leaf_entry_id ?? undefined;
  return {
    announcement,
    ...(leaf === undefined ? {} : { leaf }),
    keepEpilogue: (terminal.payload.epilogue?.length ?? 0) > 0,
  };
}

/**
 * The server's follow-ups after `runId` (KOBE-222) are shown only while that run is still the
 * thread's latest and nothing was sent since (a late epilogue never brings old chips back).
 */
export function followupsShown(s: ThreadState, runId: string, threadId: string): boolean {
  return (
    threadId === s.threadId &&
    s.live?.runId === runId &&
    s.sending === undefined &&
    !isThreadRunning(s)
  );
}
