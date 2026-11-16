import { modelGatewayState, scanTeams, withTeam, type KobeDb } from "@kobe/db";
import { MEMORY_EMBED_MAX_INPUTS } from "@kobe/protocol";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../../background.js";
import type { ReconcileLock } from "../../sandbox/reconcile-lock.js";
import type { MemoryEmbeddings } from "./service.js";
import { pendingVersions, type VectorTable } from "./vector-store.js";

/**
 * Build vectors / re-embed (KOBE-409): embeds every current memory version without a vector of the
 * Site embedding model (Site items, portable items, then each Workspace's items), 64 per gateway
 * call, on BackgroundTasks. Started only by a Site admin (saving a new embedding model, or the
 * Site console's action), never by an upgrade; paid by that admin in their current Workspace. It
 * stops at the first refusal (a budget line at 100 %, a gateway error) or when the Site model
 * changes, and can be started again. Keyword search covers every item without a current vector
 * meanwhile. One job at a time across replicas (review L6): the job holds a session advisory lock
 * ({@link MEMORY_VECTOR_BUILD_LOCK}) while it runs, and a start that cannot take it says the build
 * is already running. The console's coverage comes from the database; the job state shown is
 * the replica's own.
 */

/** The session advisory lock a running build holds (one job across replicas). */
export const MEMORY_VECTOR_BUILD_LOCK = "kobe.memory-vector-build";

export interface BuildJob {
  readonly state: "running" | "done" | "stopped";
  readonly model: string;
  readonly startedBy: string;
  readonly teamId: string;
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

/** Where to look next: the site-wide tables, then one Workspace at a time. */
interface Target {
  readonly table: VectorTable;
  readonly teamId?: string;
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

  /** Starts a job paid by `admin` in `admin.teamId`, unless one runs or vectors are unusable. */
  async start(admin: { readonly userId: string; readonly teamId: string }): Promise<BuildStart> {
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

  async #run(admin: { readonly userId: string; readonly teamId: string }, model: string) {
    let stopReason: string | null = null;
    try {
      await waitForGatewaySync(this.#o.db, this.#o.gatewaySyncWaitMs ?? 60_000);
      const teams = await scanTeams(this.#o.db, "memory vector build", async (_tx, t) => t.id);
      const targets: Target[] = [
        { table: "site" },
        { table: "portable" },
        ...teams.map((teamId) => ({ table: "workspace" as const, teamId })),
      ];
      for (const target of targets) {
        stopReason = await this.#target(admin, model, target);
        if (stopReason !== null) break;
      }
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
  async #target(
    admin: { readonly userId: string; readonly teamId: string },
    model: string,
    target: Target,
  ): Promise<string | null> {
    for (;;) {
      if ((await this.#o.embeddings.usableModel()) !== model) return "model_changed";
      const pending = await withTeam(this.#o.db, target.teamId ?? admin.teamId, (tx) =>
        pendingVersions(tx, target.table, {
          ...(target.teamId ? { teamId: target.teamId } : {}),
          model,
          limit: MEMORY_EMBED_MAX_INPUTS,
        }),
      );
      if (pending.length === 0) return null;
      const out = await this.#o.embeddings.embedAndStore(
        admin,
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
