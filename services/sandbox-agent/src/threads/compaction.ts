import {
  compactCommand,
  compactFailure,
  compactModelOf,
  compactSuccess,
  compactThrown,
  piCompactFailure,
  selectsModel,
  setModelCommand,
  type CompactErrorCode,
  type CompactReply,
} from "./compact.js";
import {
  branchSummaryFailure,
  branchSummaryPrompt,
  branchSummaryReplyOf,
  branchSummaryRequestOf,
  branchSummaryThrown,
  type BranchSummaryErrorCode,
  type BranchSummaryReply,
} from "./branch-summary.js";
import type { RunModel } from "../models/types.js";
import type { Frame, ManagerPort } from "./manager-options.js";
import { PI_REQUEST_TIMEOUT_MS, PI_SLOW_REQUEST_TIMEOUT_MS } from "./manager-util.js";
import type { Thread } from "./thread.js";

// `thread.compact` (KOBE-213) and `thread.branch_summary` (KOBE-548) for `ThreadManager`.

export async function runCompaction(
  port: ManagerPort,
  thread: Thread,
  frame: Frame<"thread.compact">,
): Promise<CompactReply> {
  if (port.draining()) return compactFailure("pi_unavailable", "sandbox is shutting down");
  if (port.options.models === undefined) {
    return compactFailure("model_not_configured", "this sandbox has no model gateway access");
  }
  // The thread is the compaction's from the busy check on (under the lock): a run.start that
  // arrives meanwhile is refused, so it never runs with the model selected below.
  const busy =
    busyFor(thread) ??
    (await thread.withLock(async () => {
      const held = busyFor(thread);
      if (held === undefined) thread.beginRun(frame.run_id, true);
      return held;
    }));
  if (busy !== undefined) return busy;
  const model = compactModelOf(frame);
  try {
    const ready = await compactReady(port, thread, model);
    if (ready !== undefined) return ready;
    // Memory only (KOBE-118): kobe-models asks for it when Pi starts summarizing.
    await thread.attachRun(
      frame.run_id,
      model,
      frame.run_token.token,
      port.options.traceparentOf?.(frame.run_id) ?? null,
    );
    // Once more with the run's file in place: `compact` goes out right after this.
    const tampered = await thread.verifyRuntime();
    if (tampered !== undefined) {
      await thread.stopTampered(tampered, "compact");
      return compactFailure("runtime_tampered", tampered);
    }
    const response = await thread.request(compactCommand(frame), PI_SLOW_REQUEST_TIMEOUT_MS);
    return response.success ? compactSuccess(response.data) : piCompactFailure(response.error);
  } catch (error) {
    // Pi may still be summarizing: stop it rather than leave it working without a run.
    if (thread.runId === frame.run_id) await thread.withLock(() => thread.stopProcess());
    return compactThrown(error);
  } finally {
    if (thread.runId === frame.run_id) thread.endRun();
  }
}

export async function runBranchSummary(
  port: ManagerPort,
  thread: Thread,
  frame: Frame<"thread.branch_summary">,
): Promise<BranchSummaryReply> {
  if (port.draining()) return branchSummaryFailure("pi_unavailable");
  if (port.options.models === undefined) return branchSummaryFailure("model_not_configured");
  const busy =
    busyFor(thread) ??
    (await thread.withLock(async () => {
      const held = busyFor(thread);
      if (held === undefined) thread.beginRun(frame.run_id, true);
      return held;
    }));
  if (busy !== undefined) return branchSummaryFailure("thread_busy");
  const model = compactModelOf(frame);
  try {
    const ready = await compactReady(port, thread, model);
    if (ready !== undefined && !ready.ok) {
      port.warn(thread.id, `branch summary not started: ${ready.error.message}`);
      return branchSummaryFailure(asBranchCode(ready.error.code));
    }
    await thread.attachRun(
      frame.run_id,
      model,
      frame.run_token.token,
      port.options.traceparentOf?.(frame.run_id) ?? null,
    );
    const tampered = await thread.verifyRuntime();
    if (tampered !== undefined) {
      await thread.stopTampered(tampered, "branch_summary");
      return branchSummaryFailure("runtime_tampered");
    }
    if (!thread.armBranchSummary(frame.run_id, branchSummaryRequestOf(frame))) {
      return branchSummaryFailure("internal");
    }
    const response = await thread.request(branchSummaryPrompt(), PI_SLOW_REQUEST_TIMEOUT_MS);
    const outcome = thread.takeBranchSummary(frame.run_id);
    if (!response.success) {
      port.warn(thread.id, `branch summary prompt refused by Pi: ${response.error}`);
      return branchSummaryFailure("summary_failed");
    }
    if (outcome !== undefined && !outcome.ok) {
      port.warn(thread.id, `branch summary ${outcome.code}: ${outcome.detail}`);
    } else if (outcome === undefined) {
      port.warn(thread.id, "branch summary: the command reported no outcome");
    }
    return branchSummaryReplyOf(outcome);
  } catch (error) {
    if (thread.runId === frame.run_id) await thread.withLock(() => thread.stopProcess());
    return branchSummaryThrown(error);
  } finally {
    if (thread.runId === frame.run_id) thread.endRun();
  }
}

/**
 * With the compaction's run begun: a Pi whose selected model is the compaction's. A running Pi
 * is switched with `set_model` (only after the tripwire found its config as the agent wrote it,
 * KOBE-169); one that does not know the model (registered for another run) is restarted once
 * with it in its model file, keeping the run. Undefined when ready.
 */
export async function compactReady(
  port: ManagerPort,
  thread: Thread,
  model: RunModel,
): Promise<CompactReply | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = await thread.withLock(async () => {
      if (attempt > 0) await thread.stopProcess({ keepRun: true });
      const failed = await port.ensureProcess(thread, undefined, model);
      return failed === undefined || failed.ok
        ? undefined
        : compactFailure(compactCode(failed.code), failed.message);
    });
    if (started !== undefined) return started;
    const tampered = await thread.verifyRuntime();
    if (tampered !== undefined) {
      await thread.stopTampered(tampered, "compact");
      return compactFailure("runtime_tampered", tampered);
    }
    if (await selectModel(port, thread, model)) return undefined;
  }
  return compactFailure("model_not_configured", "Pi did not select the compaction's model");
}

export async function selectModel(
  port: ManagerPort,
  thread: Thread,
  model: RunModel,
): Promise<boolean> {
  const gatewayUrl = port.options.models?.gatewayUrl;
  if (gatewayUrl === undefined) return false;
  const selected = async () => {
    const state = await thread.request({ type: "get_state" }, PI_REQUEST_TIMEOUT_MS);
    return state.success && selectsModel(state.data, model, gatewayUrl);
  };
  if (await selected()) return true;
  const set = await thread.request(setModelCommand(model), PI_REQUEST_TIMEOUT_MS);
  return set.success && (await selected());
}

/** A compaction is refused while the thread runs, streams or restores (the server's lock is first). */
function busyFor(thread: Thread): CompactReply | undefined {
  if (thread.runId !== undefined || thread.streaming) {
    return compactFailure("thread_busy", "thread has an active run");
  }
  if (thread.restoring) return compactFailure("thread_busy", "session restore in progress");
  return undefined;
}

/** A compaction-start failure code as a branch summary's (the same set minus compaction's own). */
function asBranchCode(code: CompactErrorCode): BranchSummaryErrorCode {
  return code === "nothing_to_compact" || code === "compaction_failed" ? "summary_failed" : code;
}

/** A failed Pi start as a `thread.compact_result` code. */
function compactCode(code: string): "pi_unavailable" | "internal" {
  return code === "pi_unavailable" ? "pi_unavailable" : "internal";
}
