import { withTeam, type KaijuDb } from "@kaiju/db";
import { readRunMemoryPlan } from "../../agents/run-memory.js";
import { SELECT_LANES } from "../items/select.js";
import { parseRunMemoryState, runMemoryStateQuery, type RunMemoryStateRow } from "../switches.js";
import type { QueryVector } from "./service.js";

/**
 * Query embeddings started early (KOBE-409 review M1). A run's query embedding goes through the
 * gateway (token checks, a budget reservation, Bifrost, the provider): far longer than the few
 * milliseconds selection may wait. So it starts when the message is accepted, beside the sandbox
 * claim or wake, and selection only takes the promise that is already running, waiting for it at
 * most its short deadline. Entries are per process: when delivery runs on another replica it finds
 * none and starts the embedding itself (late in most cases: keyword search for that message).
 */

/** How long an early embedding waits to be taken (a sandbox wake is well within it). */
export const PREFETCH_TTL_MS = 120_000;
/** Most early embeddings held at once; beyond it nothing more is started early. */
export const PREFETCH_MAX = 1_000;

interface Pending {
  readonly message: string;
  readonly vector: Promise<QueryVector | undefined>;
  readonly timer: NodeJS.Timeout;
}

/** Early query embeddings by run id, each taken once (or dropped after {@link PREFETCH_TTL_MS}). */
export class PendingQueries {
  readonly #byRun = new Map<string, Pending>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(options: { readonly ttlMs?: number; readonly max?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? PREFETCH_TTL_MS;
    this.#max = options.max ?? PREFETCH_MAX;
  }

  get size(): number {
    return this.#byRun.size;
  }

  /** Whether a new entry for `runId` may start (none yet, room left). */
  canStart(runId: string): boolean {
    return !this.#byRun.has(runId) && this.#byRun.size < this.#max;
  }

  put(runId: string, message: string, vector: Promise<QueryVector | undefined>): void {
    if (!this.canStart(runId)) return;
    const timer = setTimeout(() => this.#byRun.delete(runId), this.#ttlMs);
    timer.unref();
    this.#byRun.set(runId, { message, vector, timer });
  }

  /** The early embedding of this run's message, once; undefined when none (or another message). */
  take(runId: string, message: string): Promise<QueryVector | undefined> | undefined {
    const entry = this.#byRun.get(runId);
    if (entry === undefined) return undefined;
    this.#byRun.delete(runId);
    clearTimeout(entry.timer);
    return entry.message === message ? entry.vector : undefined;
  }
}

/**
 * Whether this run's selection would read a memory lane (so its query embedding is worth paying
 * for): the agent version gives it semantic memory and the switches allow at least one lane.
 * The same rules as delivery's (`buildRunSemantic`), read when the message is accepted.
 */
export async function runWantsVectors(
  db: KaijuDb,
  run: { readonly teamId: string; readonly runId: string },
): Promise<boolean> {
  return withTeam(db, run.teamId, async (tx) => {
    const plan = await readRunMemoryPlan(tx, run);
    if (!plan.semantic) return false;
    const res = await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(run.teamId));
    const { memory } = parseRunMemoryState(res.rows[0]);
    return SELECT_LANES.some((lane) => memory.scopes[lane]);
  });
}
