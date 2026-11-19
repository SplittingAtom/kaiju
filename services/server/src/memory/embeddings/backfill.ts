import { modelGatewayState, scanTeams, sql, withTeam, type KobeDb } from "@kobe/db";
import { MEMORY_EMBED_MAX_INPUTS } from "@kobe/protocol";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../../background.js";
import type { ReconcileLock } from "../../sandbox/reconcile-lock.js";
import type { MemoryEmbeddings } from "./service.js";
import { buildTargets, type BuildAdmin, type Payer, type Target } from "./build-payers.js";
import { pendingVersions } from "./vector-store.js";

/**
 * Build vectors / re-embed (KOBE-409): embeds every current memory version without a vector of the
 * Site embedding model (Site items, portable items, then each Workspace's items), 64 per gateway
 * call, on BackgroundTasks. Started only by a Site admin (saving a new embedding model, or the
 * Site console's action), never by an upgrade. The model is a Site setting, so the job covers
 * every Workspace whether or not the admin has an active one (KOBE-669); who pays is in
 * {@link buildTargets}. A payer's Workspace at 100 % of a budget line is skipped and the rest
 * still build (the job then ends `stopped`/`budget`); any other refusal (a gateway error) or a
 * Site model change stops it, and it can be started again. Keyword search covers every item without a current vector
 * meanwhile. One job at a time across replicas (review L6): the job holds a session advisory lock
 * ({@link MEMORY_VECTOR_BUILD_LOCK}) while it runs, and a start that cannot take it says the build
 * is already running. The console's coverage comes from the database; the job state shown is
 * the replica's own, plus whether another replica holds the lock ({@link buildRunningElsewhere}).
 */

/** The session advisory lock a running build holds (one job across replicas). */
export const MEMORY_VECTOR_BUILD_LOCK = "kobe.memory-vector-build";

export interface BuildJob {
  readonly state: "running" | "done" | "stopped";
  readonly model: string;
  readonly startedBy: string;
  /** The admin's active Workspace that pays for everything; null: each Workspace pays its own. */
  readonly teamId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Versions embedded by this job so far. */
  readonly embedded: number;
  /** Why it stopped (`budget`, `model_changed`, or the gateway's short code). */
  readonly stopReason: string | null;
}

export type BuildStart =
  | { readonly ok: true; readonly job: BuildJob }
  | { readonly ok: false; readonly code: "running" | "unavailable"; readonly message: string };

export interface BuildOptions {
  readonly db: KobeDb;
  readonly embeddings: MemoryEmbeddings;
  readonly background: BackgroundTasks;
  readonly log: Pick<Logger, "info" | "warn">;
  readonly now?: () => Date;
  /**
   * How long a job first waits for the gateway sync to push the new model onto every member's
   * virtual key (`model_gateway_state` synced at the desired version), default 60 s; then it
   * starts anyway (a refusal stops it and the admin can start it again).
   */
  readonly gatewaySyncWaitMs?: number;
  /** One job across replicas (`createPgReconcileLock` on {@link MEMORY_VECTOR_BUILD_LOCK}). */
  readonly lock?: ReconcileLock;
}

const ALREADY_RUNNING: BuildStart = {
  ok: false,
  code: "running",
  message: "Vectors are already being built.",
};

/** Polls until the gateway sync caught up with the desired configuration, or `waitMs` passed. */
async function waitForGatewaySync(db: KobeDb, waitMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const [s] = await db.select().from(modelGatewayState);
    if (!s || s.syncedVersion >= s.desiredVersion) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Whether another session (another replica's job) holds the build lock: the console shows that
 * build as running even when this replica has none. Reads `pg_locks` (no lock taken).
 */
export async function buildRunningElsewhere(db: KobeDb): Promise<boolean> {
  const res = await db.execute<{ held: boolean }>(sql`
    WITH k AS (SELECT hashtextextended(${MEMORY_VECTOR_BUILD_LOCK}, 0) AS key)
    SELECT EXISTS (
      SELECT 1 FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::bigint = (k.key >> 32) & 4294967295
        AND l.objid::bigint = k.key & 4294967295
    ) AS held`);
  return res.rows[0]?.held === true;
}

export class VectorBackfill {
  readonly #o: BuildOptions;
  #job: BuildJob | undefined;

  constructor(options: BuildOptions) {
    this.#o = options;
  }

  get job(): BuildJob | undefined {
    return this.#job;
  }

  #running(): boolean {
    return this.#job?.state === "running";
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  /**
   * Starts a Site-wide job, unless one runs or vectors are unusable: paid by `admin` in
   * `admin.teamId` when they have an active Workspace, else Workspace by Workspace.
   */
  async start(admin: BuildAdmin): Promise<BuildStart> {
    if (this.#job?.state === "running") return ALREADY_RUNNING;
    const model = await this.#o.embeddings.usableModel();
    if (model === undefined) {
      return {
        ok: false,
        code: "unavailable",
        message:
          "Vectors can't be built: set an embedding model and enable pgvector (see the notice).",
      };
    }
    // Another start on this replica may have begun while the model was read.
    if (this.#running()) return ALREADY_RUNNING;
    const previous = this.#job;
    const job: BuildJob = {
      state: "running",
      model,
      startedBy: admin.userId,
      teamId: admin.teamId,
      startedAt: this.#now(),
      finishedAt: null,
      embedded: 0,
      stopReason: null,
    };
    // Set first, so a second start on this replica meanwhile says it is running.
    this.#job = job;
    const lock = this.#o.lock;
    if (lock === undefined) {
      this.#o.background.run("memory vector build failed", () => this.#run(admin, model), {
        team_id: admin.teamId,
      });
      return { ok: true, job };
    }
    let took!: (outcome: "taken" | "busy" | "error") => void;
    const taken = new Promise<"taken" | "busy" | "error">((resolve) => {
      took = resolve;
    });
    this.#o.background.run(
      "memory vector build failed",
      async () => {
        try {
          const out = await lock.runExclusive(async () => {
            took("taken");
            await this.#run(admin, model);
          });
          if (!out.ran) took("busy");
        } catch (err) {
          took("error");
          throw err;
        }
      },
      { team_id: admin.teamId },
    );
    const outcome = await taken;
    if (outcome === "taken") return { ok: true, job };
    if (this.#job === job) this.#job = previous;
    return outcome === "busy"
      ? ALREADY_RUNNING
      : { ok: false, code: "unavailable", message: "Vectors can't be built now; try again." };
  }

  #update(change: Partial<BuildJob>): void {
    if (this.#job) this.#job = { ...this.#job, ...change };
  }

  async #run(admin: BuildAdmin, model: string) {
    let stopReason: string | null = null;
    try {
      await waitForGatewaySync(this.#o.db, this.#o.gatewaySyncWaitMs ?? 60_000);
      const teams = await scanTeams(this.#o.db, "memory vector build", async (_tx, t) => t.id);
      const targets = await buildTargets(this.#o.db, admin, teams);
      // Payers' Workspaces that refused for budget: their other targets are skipped.
      const exhausted = new Set<string>();
      for (const target of targets) {
        if (target.payer === undefined) {
          this.#o.log.warn({ team_id: target.teamId }, "memory vector build: no member to pay");
          continue;
        }
        if (exhausted.has(target.payer.teamId)) continue;
        const reason = await this.#target(target.payer, model, target);
        if (reason === "budget") exhausted.add(target.payer.teamId);
        else if (reason !== null) {
          stopReason = reason;
          break;
        }
      }
      if (stopReason === null && exhausted.size > 0) stopReason = "budget";
    } catch (err) {
      stopReason = "error";
      throw err;
    } finally {
      this.#update({
        state: stopReason === null ? "done" : "stopped",
        stopReason,
        finishedAt: this.#now(),
      });
      this.#o.log.info(
        { model, embedded: this.#job?.embedded ?? 0, stop: stopReason },
        "memory vector build finished",
      );
    }
  }

  /** Embeds one target until nothing is pending; a stop reason ends the whole job. */
  async #target(payer: Payer, model: string, target: Target): Promise<string | null> {
    for (;;) {
      if ((await this.#o.embeddings.usableModel()) !== model) return "model_changed";
      const pending = await withTeam(this.#o.db, target.teamId ?? payer.teamId, (tx) =>
        pendingVersions(tx, target.table, {
          ...(target.teamId ? { teamId: target.teamId } : {}),
          model,
          limit: MEMORY_EMBED_MAX_INPUTS,
        }),
      );
      if (pending.length === 0) return null;
      const out = await this.#o.embeddings.embedAndStore(
        payer,
        target.table,
        target.teamId,
        model,
        pending,
      );
      if ("refused" in out) return out.refused;
      // Nothing stored (rows moved on meanwhile): stop rather than ask again for the same rows.
      if (out.stored === 0) return null;
      this.#update({ embedded: (this.#job?.embedded ?? 0) + out.stored });
    }
  }
}
