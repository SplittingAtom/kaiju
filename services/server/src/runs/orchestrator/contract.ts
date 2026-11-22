import type {
  ActorContext,
  BranchSummaryResponse,
  CompactThreadResponse,
  NotebookKernelResponse,
  NotebookRunBody,
  NotebookRunResponse,
  NotebookStartResponse,
  RunOrchestrator,
  RunSnapshot,
  SubmitMessageCommand,
  SubmitMessageResult,
} from "@kobe/protocol";
import type { ScheduledCancelReason } from "../cancel-scheduled.js";
import type { ScheduledSubmit } from "../scheduled-submit.js";
import type { RunSweepResult } from "../sweeper.js";

/** The orchestrator plus what the server wires around it (wire hooks, sweeps). */
export interface ServerRunOrchestrator extends RunOrchestrator {
  /** The Stop grace a promotion waits for Pi's abort (KOBE-26); app-card launches wait it too. */
  readonly abortHoldMs?: number;
  /** `submitMessage` with a client idempotency key (unique per thread). */
  submitMessage(
    actor: ActorContext,
    command: SubmitMessageCommand,
    options?: { readonly clientKey?: string; readonly scheduled?: ScheduledSubmit },
  ): Promise<SubmitMessageResult>;
  /** The run an `interrupted` thread waits on (Retry), or null. */
  latestInterruptedRun(actor: ActorContext, threadId: string): Promise<RunSnapshot | null>;
  /** Messages wait behind a Stop until the user resumes the queue or sends one (KOBE-26). */
  queuePaused(actor: ActorContext, threadId: string): Promise<boolean>;
  /** The owner reorders the queued messages (CE10): `runIds` is the whole queue, in order. */
  reorderQueue(actor: ActorContext, threadId: string, runIds: readonly string[]): Promise<void>;
  /** The owner holds the queue until resumed or a new message (CE10); no-op with nothing queued. */
  pauseQueue(actor: ActorContext, threadId: string): Promise<void>;
  /**
   * Compact now (KOBE-213): a compaction run on the owner's idle thread, answered once Pi did it.
   * Throws `CompactionError` (a code of the compact contract) or `RunError` (404/403/trash).
   */
  compact(actor: ActorContext, threadId: string, focus?: string): Promise<CompactThreadResponse>;
  /**
   * Make it current and carry a summary (KOBE-548, CT11): a branch summary run on the owner's idle
   * thread, answered once Pi wrote the summary and the leaf moved to it. Throws
   * `BranchSummaryError` or `RunError` (404/trash).
   */
  branchSummary(
    actor: ActorContext,
    threadId: string,
    toEntryId: string,
    focus?: string,
  ): Promise<BranchSummaryResponse>;
  /**
   * The owner runs a notebook cell or a `.py` file (KOBE-464, docs/specs/notebooks.md NB6): a
   * `notebook` run on their idle thread, answered at once. Throws `NotebookRunError` or `RunError`.
   */
  notebookRun(
    actor: ActorContext,
    threadId: string,
    body: NotebookRunBody,
  ): Promise<NotebookRunResponse>;
  /** Interrupt or restart the thread's kernel (NB7); never wakes the sandbox. */
  notebookKernel(
    actor: ActorContext,
    threadId: string,
    op: "interrupt" | "restart",
  ): Promise<NotebookKernelResponse>;
  /**
   * Start the thread's kernel without running code (KOBE-477): wakes the sandbox (`waking`) or
   * answers the kernel's state. Throws `NotebookRunError` or `RunError`.
   */
  notebookStart(actor: ActorContext, threadId: string): Promise<NotebookStartResponse>;
  /** KOBE-24 `RunLifecycleHooks.onRunEnded`: the wire ended a run; advance its thread's queue. */
  onRunEnded(event: { teamId: string; runId: string; threadId: string }): Promise<void>;
  /** KOBE-180: the system cancels a deactivated or removed owner's in-flight scheduled runs. */
  cancelScheduledRuns(
    teamId: string,
    userId: string,
    reason: ScheduledCancelReason,
  ): Promise<readonly string[]>;
  sweep(): Promise<RunSweepResult>;
  /** Resolves once every background task started so far has finished (tests). */
  idle(): Promise<void>;
  close(): void;
}
