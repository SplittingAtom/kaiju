import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { ModelTokenDefaults } from "../../models/token-limits.js";
import type { NotebookFiles } from "../../notebooks/files.js";
import type { SandboxRouter } from "../../sandbox-wire/types.js";
import type { QueryPrefetch } from "../dispatch.js";
import type { IsolationProbe, RunAgentResolver, RunBudgetGate } from "../seams.js";
import type { RunWorkspace } from "./workspace.js";

/** Timings and limits (tests shorten them). */
export interface RunTuning {
  /** Queued messages one thread may hold (D17: "several run in order"). */
  readonly maxQueuedPerThread: number;
  /** After Stop, how long the next queued run waits for Pi's abort before it starts anyway. */
  readonly stopGraceMs: number;
  /**
   * A `running` run with no sandbox lease and no pending `run.start` this long after it started
   * lost its starter (replica crash): the sweep fails it. Above the wire's run.start deadline.
   */
  readonly startDeadlineMs: number;
  /**
   * A compaction run still active this long after it started has lost its requester (KOBE-213):
   * the sweep fails it and aborts it. Above the `thread.compact` command deadline.
   */
  readonly compactionDeadlineMs: number;
  /** A thread with queued runs and nothing active for this long is promoted by the sweep. */
  readonly stallMs: number;
  /** Sweep interval (jittered). */
  readonly sweepMs: number;
  /** Promotion retries when the thread row is busy (lock timeout). */
  readonly advanceAttempts: number;
  /** A lost start younger than this is re-sent; older ones fail `start_lost`. */
  readonly restartWindowMs: number;
  /** A pending stop with no `run.stop` in flight this long is sent again. */
  readonly stopResendMs: number;
  /** A stop still unanswered after this long is given up. */
  readonly stopGiveUpMs: number;
}

export const RUN_DEFAULTS: RunTuning = {
  maxQueuedPerThread: 25,
  stopGraceMs: 10_000,
  startDeadlineMs: 150_000,
  compactionDeadlineMs: 15 * 60_000,
  stallMs: 30_000,
  sweepMs: 15_000,
  advanceAttempts: 4,
  restartWindowMs: 15 * 60_000,
  stopResendMs: 60_000,
  stopGiveUpMs: 60 * 60_000,
};

export interface RunOrchestratorOptions {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  /**
   * D4: new runs start only while this answers `available` (a verified gVisor/Kata
   * RuntimeClass); `checking` and `missing` refuse `isolation_unavailable`. Required, with no
   * default: an entry point that forgets it does not compile (KOBE-708). Sandbox creation
   * enforces isolation again through `IsolationGate.require()`.
   */
  readonly isolation: IsolationProbe;
  /** Notebook files (KOBE-464); unbound from a workspace store, notebook runs are refused. */
  readonly notebooks: NotebookFiles;
  /** Message attachments and the viewed file (KOBE-144, KOBE-462), once workspace sync exists. */
  readonly workspace: RunWorkspace;
  readonly agents?: RunAgentResolver;
  readonly budget?: RunBudgetGate;
  readonly tuning?: Partial<RunTuning>;
  /** Limits of models without their own in the catalog (KOBE-259); default `MODEL_TOKEN_DEFAULTS`. */
  readonly modelTokenDefaults?: ModelTokenDefaults;
  /** Run the sweep on a timer (default true; tests call `sweep()`). */
  readonly sweep?: boolean;
  readonly log?: Logger;
  /** The early memory query embedding (KOBE-409 review M1; `RunDispatcher`). */
  readonly prefetchQuery?: (query: QueryPrefetch) => void;
}
