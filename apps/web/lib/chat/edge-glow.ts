/**
 * The chat window's edge glow (KOBE-840, Chris 2026-11-25): gold while the conversation is stopped
 * waiting for the member, red after a run failed. Pure; `components/chat/edge-glow.tsx` renders
 * it. The glow is never the only cue: each state keeps its own words on screen (the steering
 * panel's "Waiting for your approval", the header's "Interrupted", the panel's "Queue paused.",
 * the "The run failed: …" notice).
 */
import { isInterrupted, queuedMessages, runPhase } from "./steering";
import { currentRunId, type ThreadState } from "./thread-state";

export type EdgeGlow = "waiting" | "error";

/** Why the conversation waits for the member; null when it doesn't. */
export type WaitingReason = "approval" | "interrupted" | "queue-paused";

/**
 * What the run is blocked on, from the member's side. Kaiju runs have no other ask-the-member
 * state: a tool call needing an approval (D18; Git approvals are approvals too) holds the run in
 * `waiting_approval`; an interrupted run waits for Retry or Continue; a paused queue (after Stop)
 * waits for Resume or a new message. A file-edit proposal does not hold the run (its tool answers
 * `awaiting_user` and the run goes on), so it is not here.
 */
export function waitingReason(state: ThreadState): WaitingReason | null {
  if (runPhase(state, false)?.kind === "approval") return "approval";
  if (currentRunId(state) !== undefined) return null;
  if (isInterrupted(state)) return "interrupted";
  if (state.queuePaused && queuedMessages(state).length > 0) return "queue-paused";
  return null;
}

/**
 * The id of the failed run's notice (`run-notices.tsx`, closable per event, KOBE-468), while the
 * failure is the last thing on screen: no run holds the thread and nothing is being sent.
 */
export function failedNoticeId(state: ThreadState): string | null {
  const terminal = state.live?.terminal;
  if (terminal?.type !== "run.failed") return null;
  if (state.sending !== undefined || currentRunId(state) !== undefined) return null;
  return `${terminal.run_id}:${terminal.seq}`;
}

/**
 * The glow for the conversation on screen, for a member who can act on it (a shared reader and a
 * conversation in Trash get none). Gold until the member responds (the approval is decided, the
 * run retried or continued, the queue resumed); red after a failed run until the next message is
 * sent or the failure's notice is closed (`closed`).
 */
export function edgeGlow(
  state: ThreadState,
  closed: (noticeId: string) => boolean,
): EdgeGlow | null {
  if (state.threadId === null || state.phase !== "ready") return null;
  if (state.summary?.readOnly === true || state.summary?.deletedAt != null) return null;
  if (waitingReason(state) !== null) return "waiting";
  const failed = failedNoticeId(state);
  return failed !== null && !closed(failed) ? "error" : null;
}
