/**
 * The thread's queue (D17, CE10): pure planners and the actions that use them through the
 * controller's port (KOBE-716).
 */
import { currentRunId, queuedRuns, type ThreadState } from "../thread-state";
import type { RunSnapshot } from "../types";
import { withRuns } from "./history";
import type { ControllerPort } from "./port";

/** A whole queue's new order with retries kept first, as the server keeps them (D14). */
export function queueOrder(
  runs: readonly Pick<RunSnapshot, "runId" | "retryOfRunId">[],
  runIds: readonly string[],
): string[] {
  const retries = new Set(runs.filter((r) => r.retryOfRunId !== undefined).map((r) => r.runId));
  return [...runIds.filter((id) => retries.has(id)), ...runIds.filter((id) => !retries.has(id))];
}

/** Queue positions from the server's runs (those that have one). */
export function queuePositionsOf(
  runs: readonly Pick<RunSnapshot, "runId" | "queuePos">[],
): Map<string, number> {
  return new Map(runs.flatMap((r) => (r.queuePos === undefined ? [] : [[r.runId, r.queuePos]])));
}

/** The pending messages shown at these positions (others keep theirs). */
export function withQueuePositions(
  s: ThreadState,
  positions: ReadonlyMap<string, number>,
): ThreadState {
  return {
    ...s,
    pending: s.pending.map((m) => {
      const pos = positions.get(m.runId);
      return pos === undefined ? m : { ...m, queuePos: pos };
    }),
  };
}

/** Stop (D17): cancels the current run; queued messages are held until "Resume queue". */
export async function stopRun(port: ControllerPort): Promise<void> {
  const runId = currentRunId(port.state());
  if (runId === undefined) return;
  const holds = queuedRuns(port.state()).length > 0;
  // Optimistic (KOBE-269): the part stops fading at the click; a refused cancel undoes it.
  port.set((s) => ({ ...s, stopRequested: runId, queuePaused: holds || s.queuePaused }));
  const res = await port.busy("stop", () => port.api.cancel(runId));
  if (!res.ok) {
    port.set((s) => ({
      ...s,
      queuePaused: false,
      stopRequested: s.stopRequested === runId ? undefined : s.stopRequested,
    }));
    port.fail(res.error);
  } else port.announce(holds ? "Stopped. The queue is paused." : "Stopping…");
}

export async function cancelQueued(port: ControllerPort, runId: string): Promise<void> {
  const res = await port.busy(`delete:${runId}`, () => port.api.cancel(runId));
  if (!res.ok) port.fail(res.error);
  else port.announce("Queued message deleted.");
  await port.refresh();
}

export async function editQueued(
  port: ControllerPort,
  runId: string,
  text: string,
): Promise<boolean> {
  const res = await port.busy(`edit:${runId}`, () => port.api.editQueued(runId, text));
  if (!res.ok) {
    port.fail(res.error, text);
    await port.refresh();
    return false;
  }
  port.announce("Queued message updated.");
  await port.refresh();
  return true;
}

/** "Retry from last entry" (D14): a new run of the interrupted message, ahead of the queue. */
export async function retryInterrupted(port: ControllerPort): Promise<void> {
  const interrupted = port.state().interruptedRun;
  if (!interrupted) return;
  const res = await port.busy("retry", () => port.api.retry(interrupted.runId));
  if (!res.ok) {
    port.fail(res.error);
    await port.refresh();
    return;
  }
  port.announce("Retrying.");
  port.set((s) => ({ ...s, interruptedRun: null, livePrompt: undefined }));
  await port.refresh();
}

/** The held or interrupted queue runs again, announced as given. */
export async function resumeQueue(port: ControllerPort, announcement: string): Promise<void> {
  const threadId = port.state().threadId;
  if (threadId === null) return;
  const res = await port.busy("resume", () => port.api.resumeQueue(threadId));
  if (!res.ok) {
    port.fail(res.error);
    return;
  }
  port.set((s) => ({ ...s, queuePaused: false }));
  port.set((s) => withRuns(s, { ...res.data, queuePaused: res.data.queuePaused ?? false }));
  port.announce(announcement);
  await port.refresh();
}

/** Pause (CE10): the queued messages wait after the current run until resumed or a send. */
export async function pauseQueue(port: ControllerPort): Promise<void> {
  const threadId = port.state().threadId;
  if (threadId === null) return;
  const res = await port.busy("pause", () => port.api.pauseQueue(threadId));
  if (!res.ok) {
    port.fail(res.error);
    return;
  }
  port.set((s) => withRuns(s, res.data));
  port.announce("The queue is paused.");
}

/**
 * Reorder (CE10): `runIds` is the whole queue in its new order. Shown at once, with retries kept
 * first as the server keeps them (D14). The server's answer is applied as is; a stale list
 * (`queue_changed`) or any other refusal shows the error and reads the queue again.
 */
export async function reorderQueue(port: ControllerPort, runIds: readonly string[]): Promise<void> {
  const threadId = port.state().threadId;
  if (threadId === null) return;
  const order = queueOrder(port.state().runs, runIds);
  port.set((s) => withQueuePositions(s, new Map(order.map((id, i) => [id, i + 1] as const))));
  const res = await port.busy("reorder", () => port.api.reorderQueue(threadId, order));
  if (!res.ok) {
    port.fail(res.error);
    await port.refresh();
    return;
  }
  port.set((s) => withRuns(s, res.data));
  port.set((s) => withQueuePositions(s, queuePositionsOf(res.data.runs)));
  port.announce("Queue reordered.");
}
