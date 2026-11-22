import type { ActorContext, RunTransition, RunTransitionListener } from "@kobe/protocol";
import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { appendRunEventsInTx } from "../../event-stream/append.js";
import { logger as rootLogger } from "../../logger.js";
import { MODEL_TOKEN_DEFAULTS, type ModelTokenDefaults } from "../../models/token-limits.js";
import type { NotebookFiles } from "../../notebooks/files.js";
import type { SandboxRouter } from "../../sandbox-wire/types.js";
import { viewerProjectIds } from "../../threads/references.js";
import { isLockTimeout, type Viewer } from "../../threads/repository.js";
import { RunDispatcher } from "../dispatch.js";
import { RunError } from "../errors.js";
import { promoteInTx, type Promotion } from "../lifecycle.js";
import {
  NO_BUDGETS,
  PASS_THROUGH_AGENTS,
  type IsolationProbe,
  type RunAgentResolver,
  type RunBudgetGate,
} from "../seams.js";
import {
  getRunRow,
  principalActive,
  setThreadLockTimeout,
  toSnapshot,
  type AppliedTransition,
  type RunRow,
} from "../store.js";
import { RUN_DEFAULTS, type RunOrchestratorOptions, type RunTuning } from "./options.js";
import type { RunWorkspace } from "./workspace.js";

export const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * The run orchestrator's shared state and the steps its parts share (KOBE-708): transactions as
 * the actor, the account and budget check, promotion, and the one transition bus (`emit`/`notify`
 * to the listeners). `DbRunOrchestrator` is the facade; submit, queue and budget-stop work on this.
 * Internal to `runs/orchestrator*`.
 */
export class RunCore {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly agents: RunAgentResolver;
  readonly budget: RunBudgetGate;
  readonly tuning: RunTuning;
  readonly modelTokenDefaults: ModelTokenDefaults;
  readonly log: Logger;
  readonly notebooks: NotebookFiles;
  readonly workspace: RunWorkspace;
  readonly dispatch: RunDispatcher;
  readonly #isolation: IsolationProbe;
  readonly #tasks = new Set<Promise<unknown>>();
  #listeners: readonly RunTransitionListener[] = [];
  #closed = false;

  constructor(options: RunOrchestratorOptions) {
    this.db = options.db;
    this.router = options.router;
    this.#isolation = options.isolation;
    this.notebooks = options.notebooks;
    this.workspace = options.workspace;
    this.agents = options.agents ?? PASS_THROUGH_AGENTS;
    this.budget = options.budget ?? NO_BUDGETS;
    this.tuning = { ...RUN_DEFAULTS, ...options.tuning };
    this.modelTokenDefaults = options.modelTokenDefaults ?? MODEL_TOKEN_DEFAULTS;
    this.log = options.log ?? rootLogger.child({ component: "runs" });
    this.dispatch = new RunDispatcher({
      db: this.db,
      router: this.router,
      agents: this.agents,
      tuning: this.tuning,
      modelTokenDefaults: this.modelTokenDefaults,
      log: this.log,
      closed: () => this.#closed,
      emit: (teamId, transitions) => this.emit(teamId, transitions),
      advance: (teamId, threadId) => this.advance(teamId, threadId),
      track: (task) => this.track(task),
      ...(options.prefetchQuery ? { prefetchQuery: options.prefetchQuery } : {}),
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  /** Promotion waits for Pi's abort of a stopped run, at most the Stop grace (KOBE-26). */
  get hold(): { readonly abortHoldMs: number } {
    return { abortHoldMs: this.tuning.stopGraceMs };
  }

  /** D4: anything but a verified isolation runtime (`checking`, `missing`) refuses new work. */
  isolationUnavailable(): boolean {
    return this.#isolation() !== "available";
  }

  requireIsolation(): void {
    if (this.isolationUnavailable()) throw new RunError("isolation_unavailable");
  }

  track(task: Promise<unknown>): void {
    const tracked = task
      .catch((err: unknown) => this.log.error({ err }, "run orchestrator task failed"))
      .finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
  }

  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  /** A team transaction as `actor` (thread lock timeout set); a busy thread is 409 thread_busy. */
  async threadTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) {
    try {
      return await withTeam(this.db, actor.team_id, async (tx) => {
        await setThreadLockTimeout(tx);
        return fn(tx, await this.#viewer(tx, actor));
      });
    } catch (err) {
      if (isLockTimeout(err)) throw new RunError("thread_busy");
      throw err;
    }
  }

  readTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>): Promise<T> {
    return withTeam(this.db, actor.team_id, async (tx) => fn(tx, await this.#viewer(tx, actor)));
  }

  async #viewer(tx: KobeTx, actor: ActorContext): Promise<Viewer> {
    return {
      teamId: actor.team_id,
      userId: actor.user_id,
      projectIds: await viewerProjectIds(tx, actor.team_id, actor.user_id),
    };
  }

  /** KOBE-13: deactivated or removed users can't start or steer runs (budget gate: KOBE-42). */
  async assertMayRun(tx: KobeTx, actor: ActorContext, checkBudget = true): Promise<void> {
    if (!(await principalActive(tx, actor.team_id, actor.user_id))) {
      throw new RunError("forbidden", "Your account can't run agents in this team.");
    }
    if (
      checkBudget &&
      !(await this.budget.allowsNewRun(tx, { teamId: actor.team_id, userId: actor.user_id }))
    ) {
      throw new RunError("budget_exhausted");
    }
  }

  /** Promotes the thread; if `runId` did not start, records `run.queued` with its position. */
  async promoteOrQueue(
    tx: KobeTx,
    teamId: string,
    threadId: string,
    runId: string,
  ): Promise<{ promotion: Promotion; queued: boolean }> {
    const promotion = await promoteInTx(tx, this.agents, teamId, threadId, this.hold);
    // Queued only if it really waits (a run can also fail in the same transaction).
    let queued = false;
    if (promotion.plan?.runId !== runId) {
      const row = await getRunRow(tx, teamId, runId);
      queued = row?.status === "queued";
      if (row?.status === "queued" && row.queueRank !== null) {
        await appendRunEventsInTx(tx, teamId, runId, [
          {
            type: "run.queued",
            payload: { thread_id: threadId, trigger: row.trigger, queue_pos: row.queueRank },
          },
        ]);
      }
    }
    return { promotion, queued };
  }

  afterCommit(teamId: string, promotion: Promotion): void {
    this.emit(teamId, promotion.transitions);
    if (promotion.plan) this.track(this.dispatch.start(promotion.plan));
  }

  // ------------------------------------------------------------------------- transition bus

  onTransition(listener: RunTransitionListener): () => void {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  get hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  emit(teamId: string, transitions: readonly AppliedTransition[]): void {
    if (this.#listeners.length === 0 || transitions.length === 0) return;
    this.track(
      withTeam(this.db, teamId, async (tx) => {
        for (const t of transitions) {
          const row = await getRunRow(tx, teamId, t.runId);
          if (row) this.notify(row, t);
        }
      }),
    );
  }

  notify(row: RunRow, t: AppliedTransition): void {
    const transition: RunTransition = {
      run: toSnapshot(row),
      from: t.from,
      to: t.to,
      cause: t.cause,
      at: new Date().toISOString(),
    };
    for (const listener of this.#listeners) {
      try {
        listener(transition);
      } catch (err) {
        this.log.warn({ err }, "run transition listener failed");
      }
    }
  }

  // ------------------------------------------------------------------------- retries

  /** Starts the thread's next run if it may start; retried while the thread row is busy. */
  async advance(teamId: string, threadId: string): Promise<void> {
    for (let attempt = 0; attempt < this.tuning.advanceAttempts; attempt += 1) {
      if (this.#closed) return;
      try {
        const promotion = await withTeam(this.db, teamId, async (tx) => {
          await setThreadLockTimeout(tx);
          return promoteInTx(tx, this.agents, teamId, threadId, this.hold);
        });
        this.afterCommit(teamId, promotion);
        return;
      } catch (err) {
        if (!isLockTimeout(err)) throw err;
        await delay(200 * 2 ** attempt);
      }
    }
    // The sweep promotes stalled queues later.
    this.log.warn({ thread_id: threadId }, "thread busy; queue promotion left to the sweep");
  }

  /** Retries `fn` while it fails on a busy row (lock timeout), like promotion does. */
  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isLockTimeout(err) || attempt + 1 >= this.tuning.advanceAttempts) throw err;
        await delay(200 * 2 ** attempt);
      }
    }
  }
}
