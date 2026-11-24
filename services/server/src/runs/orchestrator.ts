import {
  imitatesAppContext,
  imitatesSkillRequest,
  isActiveRunStatus,
  isTerminalRunStatus,
  type ActorContext,
  type BudgetStopCommand,
  type BranchSummaryResponse,
  type CompactThreadResponse,
  type NotebookKernelResponse,
  type NotebookRunBody,
  type NotebookRunResponse,
  type NotebookStartResponse,
  type NotebookVariablesResult,
  type NotebookCompletionBody,
  type NotebookCompletionResult,
  type RunSnapshot,
  type RunTransitionListener,
  type SteerBody,
  type SubmitMessageCommand,
  type SubmitMessageResult,
  type UpdateQueuedBody,
} from "@kaiju/protocol";
import { sql, withTeam } from "@kaiju/db";
import { notebookKernel, startNotebookRun, type NotebookRunHost } from "../notebooks/user-run.js";
import { startKernel, WakeRefusals } from "../notebooks/kernel-start.js";
import { notebookVariables } from "../notebooks/variables.js";
import { notebookComplete } from "../notebooks/completion.js";
import { recordAudit } from "../audit/record.js";
import { AppendError, appendRunEvents } from "../event-stream/append.js";
import { findThread } from "../threads/repository.js";
import { cancelScheduledRuns, type ScheduledCancelReason } from "./cancel-scheduled.js";
import { RunError } from "./errors.js";
import { rewriteMentions } from "./mentions.js";
import { compactThread, type CompactionHost } from "./compaction.js";
import { summarizeBranch } from "./branch-summary.js";
import { cancelledEvent } from "./lifecycle.js";
import {
  applyTransition,
  bindUserEntry,
  getRunRow,
  isMessageRun,
  isQueuePaused,
  latestInterruptedRow,
  queuedCount,
  requestStop,
  setQueuePaused,
  threadRunRows,
  toSnapshot,
  type AppliedTransition,
} from "./store.js";
import { ownedRun } from "./access.js";
import type { StopTarget } from "./dispatch.js";
import { sweepRuns, type RunSweepResult } from "./sweeper.js";
import type { ServerRunOrchestrator } from "./orchestrator/contract.js";
import { RunCore } from "./orchestrator/core.js";
import type { RunOrchestratorOptions } from "./orchestrator/options.js";
import { markSandboxLost, stopForBudget } from "./orchestrator/budget-stop.js";
import { ownerOf, submitMessage, type SubmitOptions } from "./orchestrator/submit.js";
import {
  pauseQueue,
  reorderQueue,
  resumeQueue,
  retry,
  updateQueued,
  userActor,
} from "./orchestrator/queue.js";

export {
  RUN_DEFAULTS,
  type RunOrchestratorOptions,
  type RunTuning,
} from "./orchestrator/options.js";
export type { ServerRunOrchestrator } from "./orchestrator/contract.js";
export {
  createRunWorkspace,
  type RunWorkspace,
  type RunWorkspaceSeams,
  type RunWorkspaceSlot,
} from "./orchestrator/workspace.js";

/** Steering content shown in `steer.applied` (the event payload cap is 256 KiB). */
const STEER_EVENT_MAX_CHARS = 50_000;

const WIRE_END_CAUSES = {
  completed: "settled",
  interrupted: "sandbox_lost",
  budget_stopped: "budget_exhausted",
} as const;

/**
 * The run orchestrator (KOBE-30; contract `RunOrchestrator`, `@kaiju/protocol`). Postgres is the
 * only shared state, so every replica can serve every call: the thread row lock is the per-thread
 * mutex (D17), every status change commits with its `run.*` event, and the sandbox is reached
 * through the KOBE-24 router (which finds the replica holding the sandbox's socket). The wire ends
 * runs it observes (settled, rejected, lost) and calls `onRunEnded`; Stop, queue, retry, budget
 * stops and failed starts are decided here. Its parts live in `runs/orchestrator/` (KOBE-708):
 * submit, queue, budget stop, and the shared core with the transition bus.
 */
export class DbRunOrchestrator implements ServerRunOrchestrator {
  readonly #core: RunCore;
  /** Wakes refused for a kernel start (KOBE-477), reported to the member's next start. */
  readonly #kernelWakeRefusals = new WakeRefusals();
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: RunOrchestratorOptions) {
    this.#core = new RunCore(options);
    if (options.sweep !== false) this.#scheduleSweep();
  }

  get abortHoldMs(): number {
    return this.#core.tuning.stopGraceMs;
  }

  // ------------------------------------------------------------------------- user operations

  submitMessage(
    actor: ActorContext,
    command: SubmitMessageCommand,
    options: SubmitOptions = {},
  ): Promise<SubmitMessageResult> {
    return submitMessage(this.#core, actor, command, options);
  }

  async steer(actor: ActorContext, runId: string, body: SteerBody): Promise<RunSnapshot> {
    const core = this.#core;
    // As for a send (re-review LOW-M): only the server writes app context or a skill line.
    if (imitatesAppContext(body.content) || imitatesSkillRequest(body.content)) {
      throw new RunError("invalid_content");
    }
    const { run, message } = await core.threadTx(actor, async (tx, viewer) => {
      const found = await ownedRun(tx, viewer, runId, false);
      await core.assertMayRun(tx, actor, false);
      return {
        run: found.run,
        message: (
          await rewriteMentions(
            tx,
            ownerOf(actor.team_id, found.thread),
            body.content,
            body.mentions ?? [],
          )
        ).text,
      };
    });
    // A compaction (KOBE-213) has no turn to steer.
    if (!isActiveRunStatus(run.status) || !isMessageRun(run)) {
      throw new RunError("invalid_transition", `A ${run.status} run can't be steered.`);
    }
    const outcome = await core.router.steerRun(
      { teamId: actor.team_id, userId: actor.user_id },
      { runId, threadId: run.threadId, message },
    );
    if (!outcome.ok) {
      core.log.info({ run_id: runId, code: outcome.error.code }, "steer not delivered");
      if (outcome.error.code === "run_not_active") {
        throw new RunError(
          "invalid_transition",
          "The run is not running in your workspace (it is starting or has ended). Try again.",
        );
      }
      throw new RunError("sandbox_unavailable");
    }
    try {
      await appendRunEvents(core.db, actor.team_id, runId, [
        {
          type: "steer.applied",
          payload: { content: message.slice(0, STEER_EVENT_MAX_CHARS) },
        },
      ]);
    } catch (err) {
      // The run ended between Pi accepting the steer and this write: nothing left to show.
      if (!(err instanceof AppendError && err.code === "run_finished")) throw err;
    }
    return this.getRun(actor, runId);
  }

  async cancel(actor: ActorContext, runId: string): Promise<RunSnapshot> {
    const core = this.#core;
    const teamId = actor.team_id;
    const result = await core.threadTx(actor, async (tx, viewer) => {
      const { thread, run } = await ownedRun(tx, viewer, runId, true);
      if (run.status === "cancelled") {
        return { wasActive: false, transition: undefined, notebook: false };
      }
      if (isTerminalRunStatus(run.status)) {
        throw new RunError("invalid_transition", `The run has already ended (${run.status}).`);
      }
      const wasActive = isActiveRunStatus(run.status);
      const applied = await applyTransition(
        tx,
        thread,
        run,
        "cancelled",
        "user_cancelled",
        cancelledEvent(thread),
      );
      // Durable: if this replica dies before Pi is told, the sweep sends the abort. A notebook run
      // (KOBE-464) has no Pi: its kernel is interrupted instead, below.
      const notebook = run.kind === "notebook";
      if (wasActive && !notebook) await requestStop(tx, teamId, runId, "abort");
      // A notebook run's cell not yet delivered (the sandbox still waking) is never sent; its
      // requester reads the failure on its next poll.
      if (notebook) {
        await tx.execute(sql`
          UPDATE sandbox_commands
             SET status = 'failed', completed_at = now(),
                 result = ${JSON.stringify({ ok: false, error: { code: "run_not_active", message: "the run was stopped" } })}::jsonb
           WHERE team_id = ${teamId} AND run_id = ${runId} AND kind = 'notebook.execute'
             AND status = 'pending'`);
      }
      // Stop pauses the queue behind the run (KOBE-26); deleting a queued message does not, nor
      // does stopping a compaction (KOBE-213): messages sent meanwhile were not stopped.
      const left = await queuedCount(tx, teamId, thread.id);
      const queuePaused = wasActive && left > 0 && isMessageRun(run);
      if (queuePaused) await setQueuePaused(tx, teamId, thread.id, true);
      // Deleting the last queued message leaves nothing to pause.
      if (!wasActive && left === 0) await setQueuePaused(tx, teamId, thread.id, false);
      await recordAudit(tx, {
        action: "run.cancelled",
        actor: userActor(actor),
        teamId,
        target: { runId, threadId: thread.id, wasActive, ...(queuePaused ? { queuePaused } : {}) },
      });
      return { wasActive, transition: applied.transition, threadId: thread.id, notebook };
    });
    if (result.transition) core.emit(teamId, [result.transition]);
    if (result.wasActive && result.threadId !== undefined && result.notebook) {
      // NB7: Stop interrupts the running cell (and drops what waits); the thread is free now.
      const threadId = result.threadId;
      core.track(
        core.router
          .isConnected({ teamId, userId: actor.user_id }, threadId)
          .then((connected) =>
            connected
              ? core.router.notebookKernel(
                  { teamId, userId: actor.user_id },
                  { threadId, op: "interrupt" },
                )
              : { ok: true as const },
          )
          .then((outcome) => {
            if (!outcome.ok) {
              core.log.warn(
                { run_id: runId, code: outcome.error.code },
                "notebook stop not delivered",
              );
            }
          })
          .finally(() => core.advance(teamId, threadId)),
      );
    } else if (result.wasActive && result.threadId !== undefined) {
      // Only the owner can Stop, and the sandbox is the owner's (D11).
      core.track(
        core.dispatch.stopThenAdvance({
          teamId,
          ownerUserId: actor.user_id,
          runId,
          threadId: result.threadId,
        }),
      );
    }
    return this.getRun(actor, runId);
  }

  async updateQueued(
    actor: ActorContext,
    runId: string,
    body: UpdateQueuedBody,
  ): Promise<RunSnapshot> {
    await updateQueued(this.#core, actor, runId, body);
    return this.getRun(actor, runId);
  }

  retry(actor: ActorContext, runId: string): Promise<SubmitMessageResult> {
    return retry(this.#core, actor, runId);
  }

  resumeQueue(actor: ActorContext, threadId: string): Promise<void> {
    return resumeQueue(this.#core, actor, threadId);
  }

  reorderQueue(actor: ActorContext, threadId: string, runIds: readonly string[]): Promise<void> {
    return reorderQueue(this.#core, actor, threadId, runIds);
  }

  pauseQueue(actor: ActorContext, threadId: string): Promise<void> {
    return pauseQueue(this.#core, actor, threadId);
  }

  async getRun(actor: ActorContext, runId: string): Promise<RunSnapshot> {
    const run = await this.#core.readTx(actor, async (tx, viewer) => {
      const row = await getRunRow(tx, actor.team_id, runId);
      if (!row || !(await findThread(tx, viewer, row.threadId))) return undefined;
      return row;
    });
    if (!run) throw new RunError("run_not_found");
    return toSnapshot(run);
  }

  async listThreadRuns(actor: ActorContext, threadId: string): Promise<readonly RunSnapshot[]> {
    const rows = await this.#core.readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) return undefined;
      return threadRunRows(tx, actor.team_id, threadId);
    });
    if (!rows) throw new RunError("thread_not_found");
    // A compaction in progress is not a turn (KOBE-213): the thread's status shows it.
    return rows.filter(isMessageRun).map(toSnapshot);
  }

  /**
   * The interrupted run an `interrupted` thread waits on (Retry or Continue, D14), so a client that
   * reloads can still offer Retry; null otherwise.
   */
  async latestInterruptedRun(actor: ActorContext, threadId: string): Promise<RunSnapshot | null> {
    const row = await this.#core.readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) throw new RunError("thread_not_found");
      return latestInterruptedRow(tx, actor.team_id, threadId);
    });
    return row ? toSnapshot(row) : null;
  }

  async queuePaused(actor: ActorContext, threadId: string): Promise<boolean> {
    return this.#core.readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) throw new RunError("thread_not_found");
      return (
        (await isQueuePaused(tx, actor.team_id, threadId)) &&
        (await queuedCount(tx, actor.team_id, threadId)) > 0
      );
    });
  }

  async compact(
    actor: ActorContext,
    threadId: string,
    focus?: string,
  ): Promise<CompactThreadResponse> {
    this.#core.requireIsolation();
    return compactThread(this.#compactionHost(), actor, threadId, focus);
  }

  async branchSummary(
    actor: ActorContext,
    threadId: string,
    toEntryId: string,
    focus?: string,
  ): Promise<BranchSummaryResponse> {
    this.#core.requireIsolation();
    return summarizeBranch(this.#compactionHost(), actor, threadId, toEntryId, focus);
  }

  /** What a compaction or a branch summary run borrows (KOBE-213, KOBE-548). */
  #compactionHost(): CompactionHost {
    const core = this.#core;
    return {
      db: core.db,
      router: core.router,
      agents: core.agents,
      modelTokenDefaults: core.modelTokenDefaults,
      log: core.log,
      threadTx: (a, fn) => core.threadTx(a, fn),
      assertMayRun: (tx, a) => core.assertMayRun(tx, a),
      ended: (teamId, runId, id) => this.onRunEnded({ teamId, runId, threadId: id }),
      abort: (target) => core.track(core.dispatch.sendStop(target, "abort")),
    };
  }

  notebookRun(
    actor: ActorContext,
    threadId: string,
    body: NotebookRunBody,
  ): Promise<NotebookRunResponse> {
    return startNotebookRun(this.#notebookHost(), actor, threadId, body);
  }

  notebookKernel(
    actor: ActorContext,
    threadId: string,
    op: "interrupt" | "restart",
  ): Promise<NotebookKernelResponse> {
    return notebookKernel(this.#notebookHost(), actor, threadId, op);
  }

  notebookStart(actor: ActorContext, threadId: string): Promise<NotebookStartResponse> {
    return startKernel(this.#notebookHost(), this.#kernelWakeRefusals, actor, threadId);
  }

  notebookVariables(
    actor: ActorContext,
    threadId: string,
    refresh = false,
    show?: string,
  ): Promise<NotebookVariablesResult> {
    return notebookVariables(this.#notebookHost(), actor, threadId, refresh, show);
  }

  notebookComplete(
    actor: ActorContext,
    threadId: string,
    body: NotebookCompletionBody,
  ): Promise<NotebookCompletionResult> {
    return notebookComplete(this.#notebookHost(), actor, threadId, body);
  }

  #notebookHost(): NotebookRunHost {
    const core = this.#core;
    return {
      db: core.db,
      router: core.router,
      files: core.notebooks,
      log: core.log,
      isolationMissing: () => core.isolationUnavailable(),
      threadTx: (a, fn) => core.threadTx(a, fn),
      assertMayRun: (tx, a) => core.assertMayRun(tx, a, false),
      ended: (teamId, runId, id) => this.onRunEnded({ teamId, runId, threadId: id }),
      track: (task) => core.track(task),
    };
  }

  // ------------------------------------------------------------------------- internal entry points

  stopForBudget(command: BudgetStopCommand): Promise<readonly string[]> {
    return stopForBudget(this.#core, command);
  }

  cancelScheduledRuns(
    teamId: string,
    userId: string,
    reason: ScheduledCancelReason,
  ): Promise<readonly string[]> {
    const core = this.#core;
    const ctx = {
      db: core.db,
      withRetry: <T>(fn: () => Promise<T>) => core.withRetry(fn),
      emit: (team: string, transitions: readonly AppliedTransition[]) =>
        core.emit(team, transitions),
      stopThenAdvance: (target: StopTarget) => core.track(core.dispatch.stopThenAdvance(target)),
      log: core.log,
    };
    return cancelScheduledRuns(ctx, teamId, userId, reason);
  }

  markSandboxLost(teamId: string, sandboxId: string): Promise<readonly string[]> {
    return markSandboxLost(this.#core, teamId, sandboxId, (event) => this.onRunEnded(event));
  }

  onTransition(listener: RunTransitionListener): () => void {
    return this.#core.onTransition(listener);
  }

  async onRunEnded(event: { teamId: string; runId: string; threadId: string }): Promise<void> {
    const core = this.#core;
    if (core.closed) return;
    try {
      await withTeam(core.db, event.teamId, (tx) => bindUserEntry(tx, event.teamId, event.runId));
    } catch (err) {
      core.log.warn({ err, run_id: event.runId }, "could not bind the run's prompt entry");
    }
    try {
      await this.#notifyWireEnd(event);
    } catch (err) {
      core.log.warn({ err, run_id: event.runId }, "could not report a run transition");
    }
    await core.advance(event.teamId, event.threadId);
  }

  async #notifyWireEnd(event: { teamId: string; runId: string }): Promise<void> {
    const core = this.#core;
    if (!core.hasListeners) return;
    const row = await withTeam(core.db, event.teamId, (tx) =>
      getRunRow(tx, event.teamId, event.runId),
    );
    if (!row || !isTerminalRunStatus(row.status)) return;
    // The wire ended an active run; it reports neither the prior state nor the cause.
    const cause = WIRE_END_CAUSES[row.status as keyof typeof WIRE_END_CAUSES] ?? "error";
    core.notify(row, {
      runId: row.id,
      threadId: row.threadId,
      from: "running",
      to: row.status,
      cause,
    });
  }

  async sweep(): Promise<RunSweepResult> {
    const core = this.#core;
    const result = await sweepRuns(core.db, core.tuning, core.log);
    // Each finding is handled on its own: one failure never blocks the others.
    const each = async (what: string, id: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        core.log.error({ err, id }, `run sweep: ${what} failed`);
      }
    };
    for (const lost of result.lostStarts) {
      await each("lost start", lost.runId, () => core.dispatch.recoverStart(lost));
    }
    for (const stale of result.staleCompactions) {
      await each("stale compaction", stale.runId, () => core.dispatch.failStaleCompaction(stale));
    }
    for (const stop of result.pendingStops) {
      // In the background: a stop waits for the sandbox's answer.
      core.track(each("pending stop", stop.runId, () => core.dispatch.recoverStop(stop)));
    }
    for (const t of result.stalledThreads) {
      await each("stalled queue", t.threadId, () => core.advance(t.teamId, t.threadId));
    }
    return result;
  }

  idle(): Promise<void> {
    return this.#core.idle();
  }

  close(): void {
    this.#core.close();
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
  }

  #scheduleSweep(): void {
    this.#sweepTimer = setTimeout(
      () => {
        this.sweep()
          .catch((err: unknown) => this.#core.log.error({ err }, "run sweep failed"))
          .finally(() => {
            if (!this.#core.closed) this.#scheduleSweep();
          });
      },
      this.#core.tuning.sweepMs * (0.5 + Math.random()),
    );
    this.#sweepTimer.unref();
  }
}
