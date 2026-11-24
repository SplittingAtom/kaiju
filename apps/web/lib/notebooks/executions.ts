/**
 * Kernel executions as the web sees them (KOBE-465; events NB15): one store per chat session,
 * fed by the thread's run streams (the agent's `run_python` calls) and by the streams of the
 * member's own `notebook` runs, so the open notebook shows both live. Assembled from
 * `notebook.started` / `notebook.output` / `notebook.finished`; a replayed event changes nothing.
 * Immutable snapshots for `useSyncExternalStore`.
 */
import type {
  KaijuEvent,
  KaijuEventPayload,
  NotebookExecStatus,
  NotebookFinishedPayload,
  NotebookHistoryEntry,
  NotebookOutput,
} from "@kaiju/protocol";

export interface ExecutionEnd {
  readonly status: NotebookExecStatus;
  readonly executionCount: number | null;
  readonly truncated: boolean;
  /** The `.ipynb` version holding the outputs; null when nothing was saved. */
  readonly saved: { readonly path: string; readonly sha256: string } | null;
  readonly saveError?: string | undefined;
  /** KOBE-803: when it ran and how long (absent from older sandboxes, or when it never ran). */
  readonly timing?: ExecutionTiming | undefined;
  /** KOBE-803: an `error` execution's exception and its line in the code that ran. */
  readonly error?: { readonly name: string; readonly line?: number | undefined } | undefined;
}

export interface ExecutionTiming {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/** Run selection (KOBE-805): the file's lines that ran (1-based, inclusive). */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface Execution {
  readonly threadId: string;
  readonly runId: string;
  readonly execId: string;
  readonly origin: "user" | "agent";
  readonly toolCallId?: string | undefined;
  readonly path?: string | undefined;
  readonly cellId?: string | undefined;
  /** The `notebook.started` event's time (the server's; this tab's clock for its own Run). */
  readonly startedAt?: string | undefined;
  /** When this tab first saw it (this browser's clock): a running execution's live clock. */
  readonly seenAt?: number | undefined;
  /** Only these lines of the file ran (a Run selection, KOBE-805; from `notebook.started`). */
  readonly lines?: LineRange | undefined;
  /** Read from the stored history (KOBE-804) without its outputs yet: fetch them to show it. */
  readonly outputsPending?: boolean | undefined;
  /** By index; a gap (an output not arrived yet) is undefined. */
  readonly outputs: readonly (NotebookOutput | undefined)[];
  readonly finished?: ExecutionEnd | undefined;
}

export interface BlockedDomain {
  readonly runId: string;
  readonly payload: KaijuEventPayload<"egress.blocked">;
  /** The event's server time (KOBE-609): the card ignores decisions older than the block. */
  readonly blockedAt: string;
}

type Listener = () => void;

/** Executions kept per session; the oldest are forgotten first. */
export const EXECUTIONS_KEPT = 200;

const RUN_END_STATUS: Partial<Record<KaijuEvent["type"], NotebookExecStatus>> = {
  "run.completed": "failed",
  "run.failed": "failed",
  "run.budget_stopped": "failed",
  "run.interrupted": "interrupted",
};

export class NotebookExecStore {
  #execs: readonly Execution[] = [];
  #egress: readonly BlockedDomain[] = [];
  #listeners: readonly Listener[] = [];
  readonly #max: number;

  constructor(max = EXECUTIONS_KEPT) {
    this.#max = max;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  snapshot = (): readonly Execution[] => this.#execs;

  egress = (): readonly BlockedDomain[] => this.#egress;

  /** Run `runId` ended without its executions' end reaching this tab: they end `failed`. */
  endRun(runId: string): void {
    const execs = this.#execs;
    if (!execs.some((e) => e.runId === runId && e.finished === undefined)) return;
    this.#execs = endExecutions(execs, runId, "failed");
    for (const l of this.#listeners) l();
  }

  /**
   * The file's past executions from the server (KOBE-804, `GET .../notebook/executions`, newest
   * first): the ones this tab has not seen go before the ones it has, without their outputs.
   */
  seed(threadId: string, entries: readonly NotebookHistoryEntry[]): void {
    const known = new Set(this.#execs.map((e) => e.execId));
    const added = entries
      // One still running reaches this tab through its run's stream instead.
      .filter((h) => !known.has(h.started.exec_id) && (h.finished !== null || h.run_ended))
      .reverse()
      .map((h): Execution => {
        const p = h.started;
        return {
          threadId,
          runId: h.run_id,
          execId: p.exec_id,
          origin: p.origin,
          toolCallId: p.tool_call_id,
          path: p.path,
          cellId: p.cell_id,
          lines: p.lines,
          startedAt: h.started_at,
          seenAt: pastInstant(h.started_at),
          outputs: [],
          // One whose run ended first may still have stored outputs (review R2-L2).
          outputsPending: h.finished === null || h.finished.outputs > 0,
          // Its run ended before it did: it ended `failed`, as `endRun` says live.
          finished:
            h.finished === null
              ? { status: "failed", executionCount: null, truncated: false, saved: null }
              : endOf(h.finished),
        };
      });
    if (added.length === 0) return;
    const execs = [...added, ...this.#execs];
    this.#execs = execs.length > this.#max ? execs.slice(execs.length - this.#max) : execs;
    for (const l of this.#listeners) l();
  }

  /** A seeded execution's outputs arrived (KOBE-804). */
  fillOutputs(execId: string, outputs: readonly NotebookOutput[]): void {
    const execs = update(this.#execs, execId, (e) =>
      e.outputsPending === true ? { ...e, outputs, outputsPending: false } : e,
    );
    if (execs === this.#execs) return;
    this.#execs = execs;
    for (const l of this.#listeners) l();
  }

  /** A batch of one run's events of thread `threadId`, in seq order. */
  apply(threadId: string, events: readonly KaijuEvent[]): void {
    let execs = this.#execs;
    let egress = this.#egress;
    for (const event of events) {
      execs = applyOne(execs, threadId, event);
      if (event.type === "egress.blocked") egress = withBlocked(egress, event);
    }
    if (execs === this.#execs && egress === this.#egress) return;
    this.#execs = execs.length > this.#max ? execs.slice(execs.length - this.#max) : execs;
    this.#egress = egress;
    for (const l of this.#listeners) l();
  }
}

/**
 * When it started by this browser's clock (the live clock, review L2): the server's time, but
 * never in this browser's future (clock skew), so a reload keeps counting from the real start.
 */
function pastInstant(iso: string): number {
  const t = Date.parse(iso);
  const now = Date.now();
  return Number.isNaN(t) ? now : Math.min(t, now);
}

function endOf(p: NotebookFinishedPayload): ExecutionEnd {
  return {
    status: p.status,
    executionCount: p.execution_count,
    truncated: p.truncated,
    saved: p.saved,
    saveError: p.save_error,
    timing:
      p.timing === undefined
        ? undefined
        : {
            startedAt: p.timing.started_at,
            finishedAt: p.timing.finished_at,
            durationMs: p.timing.duration_ms,
          },
    error: p.error,
  };
}

function withBlocked(egress: readonly BlockedDomain[], event: KaijuEvent): readonly BlockedDomain[] {
  if (event.type !== "egress.blocked") return egress;
  const known = egress.some(
    (b) => b.runId === event.run_id && b.payload.domain === event.payload.domain,
  );
  return known
    ? egress
    : [...egress, { runId: event.run_id, payload: event.payload, blockedAt: event.ts }];
}

function endExecutions(
  execs: readonly Execution[],
  runId: string,
  status: NotebookExecStatus,
): readonly Execution[] {
  return execs.map((e) =>
    e.runId === runId && e.finished === undefined
      ? { ...e, finished: { status, executionCount: null, truncated: false, saved: null } }
      : e,
  );
}

function update(
  execs: readonly Execution[],
  execId: string,
  change: (e: Execution) => Execution,
): readonly Execution[] {
  const at = execs.findIndex((e) => e.execId === execId);
  if (at < 0) return execs;
  const current = execs[at] as Execution;
  const next = change(current);
  return next === current ? execs : execs.map((e, i) => (i === at ? next : e));
}

function applyOne(
  execs: readonly Execution[],
  threadId: string,
  event: KaijuEvent,
): readonly Execution[] {
  switch (event.type) {
    case "notebook.started": {
      const p = event.payload;
      if (execs.some((e) => e.execId === p.exec_id)) return execs;
      return [
        ...execs,
        {
          threadId,
          runId: event.run_id,
          execId: p.exec_id,
          origin: p.origin,
          toolCallId: p.tool_call_id,
          path: p.path,
          cellId: p.cell_id,
          lines: p.lines,
          startedAt: event.ts,
          seenAt: pastInstant(event.ts),
          outputs: [],
        },
      ];
    }
    case "notebook.output": {
      const { exec_id, index, output } = event.payload;
      return update(execs, exec_id, (e) => {
        if (e.outputs[index] !== undefined) return e;
        const outputs = [...e.outputs];
        outputs[index] = output;
        return { ...e, outputs };
      });
    }
    case "notebook.finished": {
      const p = event.payload;
      return update(execs, p.exec_id, (e) =>
        e.finished !== undefined ? e : { ...e, finished: endOf(p) },
      );
    }
    default: {
      const status = RUN_END_STATUS[event.type];
      if (status === undefined) return execs;
      if (!execs.some((e) => e.runId === event.run_id && e.finished === undefined)) return execs;
      return endExecutions(execs, event.run_id, status);
    }
  }
}

/** The newest execution of this file (and cell: undefined for a whole `.py` file) in the thread. */
export function latestRun(
  execs: readonly Execution[],
  threadId: string,
  path: string,
  cellId?: string,
): Execution | undefined {
  for (let i = execs.length - 1; i >= 0; i--) {
    const e = execs[i] as Execution;
    if (e.threadId === threadId && e.path === path && e.cellId === cellId) return e;
  }
  return undefined;
}

/** This file's executions in the thread (a `.py` file: no cell), newest first: the Log tab. */
export function fileRuns(
  execs: readonly Execution[],
  threadId: string,
  path: string,
): readonly Execution[] {
  return execs
    .filter((e) => e.threadId === threadId && e.path === path && e.cellId === undefined)
    .reverse();
}

/** The thread's newest finished execution, of any file or code (the kernel's state changed). */
export function lastFinished(execs: readonly Execution[], threadId: string): Execution | undefined {
  for (let i = execs.length - 1; i >= 0; i--) {
    const e = execs[i] as Execution;
    if (e.threadId === threadId && e.finished !== undefined) return e;
  }
  return undefined;
}

/** Whether the thread's kernel is running something now. */
export function kernelBusy(execs: readonly Execution[], threadId: string): boolean {
  return execs.some((e) => e.threadId === threadId && e.finished === undefined);
}

/** The agent's `run_python {code}` executions in the thread (not tied to a file). */
export function agentCodeRuns(execs: readonly Execution[], threadId: string): readonly Execution[] {
  return execs.filter((e) => e.threadId === threadId && e.origin === "agent" && !e.path);
}

/** Domains blocked during the member's own runs of this file (NB17): the egress notice. */
export function egressNotices(
  execs: readonly Execution[],
  egress: readonly BlockedDomain[],
  threadId: string,
  path: string,
): readonly BlockedDomain[] {
  const runs = new Set(
    execs
      .filter((e) => e.threadId === threadId && e.origin === "user" && e.path === path)
      .map((e) => e.runId),
  );
  return egress.filter((b) => runs.has(b.runId));
}
