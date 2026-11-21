import { isExcludedPath, type RunStartFrame } from "@kobe/protocol";
import { MoveReplay } from "./moves.js";
import { NO_CHECKOUTS, statLocal, type Checkouts } from "./fs.js";
import { pull } from "./sync/pull.js";
import { planPush, push, pushOne } from "./sync/push.js";
import { restoreUntilDone } from "./sync/restore.js";
import { serial, warn, type SyncState } from "./sync/state.js";
import {
  DEFAULT_SKIP_DIRS,
  PushPathError,
  type ConflictListener,
  type PushedFile,
  type PushStats,
  type WorkspaceSyncOptions,
} from "./sync/types.js";

export {
  DEFAULT_SKIP_DIRS,
  EVICTED_PREFIX,
  PushPathError,
  type ConflictListener,
  type ConflictReport,
  type PushedFile,
  type PushStats,
  type RestoreStats,
  type WorkspaceSyncOptions,
} from "./sync/types.js";

const RUN_END_DEBOUNCE_MS = 2_000;
/** KOBE-733: the pause before the one retry of a proof the server got before the hibernation. */
const PROOF_RETRY_MS = 2_000;

/** What the agent hands its final flush to prove the copy complete (KOBE-733). */
export interface ReclaimProof {
  /** The agent's last wire connection (`hello.ack`), which the hibernation closed. */
  readonly connectionId: string;
  /** Run right before the completeness check: no other process alive, no failed cleanup. */
  readonly quiet: () => Promise<boolean>;
  readonly retryDelayMs?: number;
}

/**
 * kobe-sandbox-agent's side of workspace sync (KOBE-27, D13: the agent "syncs S3 ↔ /workspace").
 * The server brokers every byte (SyncClient); this class decides what moves:
 *
 * - **restore** (startup: a wake or a rebuild): full manifest vs the volume. Missing files are
 *   downloaded (an empty volume → a full restore), unchanged ones are kept without reading them
 *   (size + mtime), local edits newer than the copy are kept and pushed. Runs in parallel with
 *   the wire connection and Pi's start; `beforeRun` waits for it, so a run's first prompt never
 *   reaches Pi before the workspace is back.
 * - **pull** (before every run, and periodically): changes since the last seen revision — server
 *   writes such as uploads (`uploads/<thread>/`, KOBE-53) and project files (`projects/<slug>/`,
 *   KOBE-57), which are server-owned and read-only here — and the member's project checkouts
 *   (CM4, KOBE-580): a checked-out `projects/<slug>/` is free area (scanned, pushed, 0664/0775)
 *   while its slug is in the latest pull; when it leaves, the folder is relocked and brought back
 *   to the head the server sends (the read-only area's restore rule).
 * - **push** (every interval, soon after a run ends, and when stopping for hibernation): local
 *   changes → upload content the server lacks → commit with each path's base revision.
 *
 * Conflict rule (contract): a newer server-written version keeps the path and the local edit is
 * kept beside it as `<name>.conflict-<time><ext>`; a deletion never beats a modification.
 *
 * This class keeps the scheduling; the steps are in `sync/` (restore, pull, push), over one
 * {@link SyncState} the class owns.
 */
export class WorkspaceSync {
  readonly #s: SyncState;
  /** The sync-now push not started yet (shared by the requests that wait for it), KOBE-599. */
  #nowQueued: Promise<boolean> | undefined;
  /** The sync-now push running now. */
  #nowRunning: Promise<boolean> | undefined;
  /** Settles once the startup restore succeeded, or the server said it has no workspace sync. */
  #ready: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #soon: NodeJS.Timeout | undefined;

  constructor(options: WorkspaceSyncOptions) {
    const o = {
      // Matches the server's per-sandbox limits (a few short transactions at a time).
      concurrency: 2,
      maxFiles: 200_000,
      restoreWaitMs: 60_000,
      now: () => new Date(),
      ...options,
      skipDirs: new Set<string>(options.skipDirs ?? DEFAULT_SKIP_DIRS),
    };
    this.#s = {
      o,
      known: new Map(),
      refused: new Map(),
      unreadable: new Set(),
      retry: new Map(),
      deferred: new Map(),
      moves: new MoveReplay(o.root, o.client, o.logger),
      seenRev: 0,
      chain: Promise.resolve(),
      settle: () => {},
      restored: false,
      stopped: false,
      conflictListener: undefined,
      unavailable: false,
      emptyAtStart: undefined,
      restoredFiles: 0,
      restoredBytes: 0,
      restoreStarted: 0,
      checkouts: NO_CHECKOUTS,
    };
  }

  /**
   * The member moved or renamed files (`workspace.moved`, KOBE-304): replay the moves as local
   * renames and pull now rather than at the next interval.
   */
  movedOnServer(): void {
    if (!this.enabled || !this.#s.restored || this.#s.stopped) return;
    void serial(this.#s, () => pull(this.#s)).catch((error: unknown) =>
      warn(this.#s, "workspace pull after a server move failed", error),
    );
  }

  get enabled(): boolean {
    return this.#s.o.intervalMs > 0 && !this.#s.unavailable;
  }

  /** The checked-out project slugs the latest pull listed (tests, diagnostics). */
  get checkouts(): Checkouts {
    return this.#s.checkouts;
  }

  /** Starts the restore (retried until it succeeds) and the periodic push + pull. */
  start(): void {
    if (this.#s.o.intervalMs <= 0) return;
    this.#ready = new Promise<void>((resolve) => {
      this.#s.settle = resolve;
    });
    void restoreUntilDone(this.#s).finally(() => this.#s.settle());
    this.#timer = setInterval(() => {
      if (!this.#s.restored || this.#s.stopped) return;
      void (async () => {
        await push(this.#s);
        await serial(this.#s, () => pull(this.#s));
      })().catch((error: unknown) => warn(this.#s, "periodic workspace sync failed", error));
    }, this.#s.o.intervalMs);
    this.#timer.unref();
  }

  /**
   * Before a run's prompt reaches Pi (ThreadManager `beforeRun`): the restore is done (or has
   * failed for `restoreWaitMs`), the latest server writes are pulled, and the run's attachments
   * are present. A missing attachment fails the run.
   */
  async beforeRun(frame: RunStartFrame): Promise<void> {
    if (!this.enabled || this.#ready === undefined) return;
    const restored = await Promise.race([
      this.#ready.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), this.#s.o.restoreWaitMs).unref()),
    ]);
    if (!restored || !this.#s.restored) {
      if (this.enabled) {
        this.#s.o.logger.warn({}, "workspace restore still failing: starting the run without it");
      }
    } else {
      await serial(this.#s, () => pull(this.#s)).catch((error: unknown) =>
        warn(this.#s, "workspace pull before the run failed", error),
      );
    }
    for (const attachment of frame.attachments ?? []) {
      const rel = attachment.path.startsWith(`${this.#s.o.root}/`)
        ? attachment.path.slice(this.#s.o.root.length + 1)
        : attachment.path;
      if ((await statLocal(this.#s.o.root, rel)) === undefined) {
        throw new Error(`attachment ${rel} is not in the workspace`);
      }
    }
  }

  /** A run ended: push its outputs soon (debounced). */
  runEnded(): void {
    if (!this.enabled || this.#s.stopped) return;
    clearTimeout(this.#soon);
    this.#soon = setTimeout(() => {
      if (!this.#s.restored) return;
      void push(this.#s).catch((error: unknown) =>
        warn(this.#s, "workspace push after a run failed", error),
      );
    }, RUN_END_DEBOUNCE_MS);
    this.#soon.unref();
  }

  /**
   * Final push before the sandbox stops (hibernation, shutdown), bounded by `deadlineMs`. A restore
   * or pull in flight finishes first (within the deadline): nothing of this sync writes into the
   * workspace after the flush, its saved revision (KOBE-304) included.
   *
   * KOBE-733: with `proof` (the agent's last wire connection and its quiet check), called once
   * every Pi, tool process and kernel is gone, a successful push is followed by the quiet check
   * and a fresh completeness check; only when both pass is the reclaim proof sent (`POST
   * flushed`), retried once if the server has not committed the hibernation yet. Any failure,
   * timeout or doubt sends nothing, so the volume is kept.
   */
  async flush(deadlineMs: number, proof?: ReclaimProof): Promise<PushStats | undefined> {
    this.#s.stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#soon);
    if (!this.enabled) return undefined;
    const timeout = new Promise<undefined>((r) =>
      setTimeout(() => r(undefined), deadlineMs).unref(),
    );
    const settled = await Promise.race([this.#s.chain.then(() => true), timeout]);
    if (settled === undefined) {
      this.#s.o.logger.warn({ deadlineMs }, "workspace flush timed out");
      return undefined;
    }
    if (!this.#s.restored) return undefined;
    const pushing = push(this.#s);
    try {
      const stats = await Promise.race([pushing, timeout]);
      if (stats === undefined) {
        this.#s.o.logger.warn({ deadlineMs }, "workspace flush timed out");
        return undefined;
      }
      this.#s.o.logger.info({ ...stats }, "workspace flushed");
      if (proof !== undefined) {
        const proven = await Promise.race([this.#prove(proof), timeout]);
        this.#s.o.logger.info({ proven: proven === true }, "workspace reclaim proof");
      }
      return stats;
    } catch (error) {
      warn(this.#s, "workspace flush failed", error);
      return undefined;
    }
  }

  /**
   * Sync now (`workspace.sync_now`, KOBE-599: the Files panel's Refresh): one push that starts
   * after this call, so every file written before it is pushed. Requests made while that push has
   * not started yet share it; a request made while it runs waits for the next one. Resolves true
   * once the push committed (or found nothing to push), false when sync is off, stopping, still
   * restoring after `restoreWaitMs`, or the push failed. Never rejects.
   */
  syncNow(): Promise<boolean> {
    if (!this.enabled || this.#s.stopped) return Promise.resolve(false);
    if (this.#nowQueued) return this.#nowQueued;
    const previous = this.#nowRunning ?? Promise.resolve(true);
    const next: Promise<boolean> = previous.then(async () => {
      this.#nowQueued = undefined; // started: a later request queues the next push
      this.#nowRunning = next;
      try {
        await Promise.race([
          this.ready(),
          new Promise<void>((resolve) => setTimeout(resolve, this.#s.o.restoreWaitMs).unref()),
        ]);
        if (!this.#s.restored || this.#s.stopped) return false;
        await push(this.#s);
        return true;
      } catch (error) {
        warn(this.#s, "workspace push on request failed", error);
        return false;
      } finally {
        if (this.#nowRunning === next) this.#nowRunning = undefined;
      }
    });
    this.#nowQueued = next;
    return next;
  }

  /** The completeness check, then the proof (false on any doubt or error; never throws). */
  async #prove(proof: ReclaimProof): Promise<boolean> {
    try {
      if (!(await proof.quiet())) {
        this.#s.o.logger.warn({}, "workspace reclaim proof not sent: other processes alive");
        return false;
      }
      if (!(await this.#complete())) return false;
      const first = await this.#s.o.client.flushed(proof.connectionId);
      if (first.proven || first.reason !== "not_hibernated") return first.proven;
      // The server may still be committing the hibernation: once more, shortly after.
      await new Promise((r) => setTimeout(r, proof.retryDelayMs ?? PROOF_RETRY_MS).unref());
      return (await this.#s.o.client.flushed(proof.connectionId)).proven;
    } catch (error) {
      warn(this.#s, "workspace reclaim proof not sent", error);
      return false;
    }
  }

  /** After a push: whether a fresh plan finds every local change in the durable copy. */
  async #complete(): Promise<boolean> {
    const s = this.#s;
    const plan = await serial(s, () => planPush(s, { strict: true }));
    return (
      plan.changes.length === 0 &&
      plan.resends.length === 0 &&
      plan.leftOut === 0 &&
      !plan.partialScan
    );
  }

  /** One push now (tests, operators). */
  push(): Promise<PushStats> {
    return push(this.#s);
  }

  /**
   * Pushes every local change now, for `commit_project` (CM6: the manifest must hold the working
   * copy before the server diffs it). Throws {@link PushPathError} when sync is off, the restore
   * has not finished, or the push failed; a file the server refused stays out of the commit.
   */
  async pushAll(): Promise<PushStats> {
    if (!this.enabled) throw new PushPathError("workspace sync is not available");
    await Promise.race([
      this.ready(),
      new Promise<void>((resolve) => setTimeout(resolve, this.#s.o.restoreWaitMs).unref()),
    ]);
    if (!this.#s.restored) throw new PushPathError("the workspace is still being restored");
    try {
      return await push(this.#s);
    } catch (error) {
      warn(this.#s, "workspace push for a commit failed", error);
      throw new PushPathError("the working copy could not be pushed to the Kobe server");
    }
  }

  /**
   * Pushes exactly one file now (blob + commit) and returns its entry, for `share_file`: the
   * server shares only a file whose live row has this `rev` and `sha256`. Nothing else is pushed.
   * The file is read without following links (a swapped symlink fails here, not later). Throws
   * {@link PushPathError} when it cannot be left synced (sync off, not a regular file, too large,
   * server refused, a newer server version won).
   */
  async pushPath(rel: string): Promise<PushedFile> {
    if (!this.enabled) throw new PushPathError("workspace sync is not available");
    if (isExcludedPath(rel) || rel.split("/").some((part) => this.#s.o.skipDirs.has(part))) {
      throw new PushPathError(`${rel} is not part of the synced workspace`);
    }
    await Promise.race([
      this.ready(),
      new Promise<void>((resolve) => setTimeout(resolve, this.#s.o.restoreWaitMs).unref()),
    ]);
    if (!this.#s.restored) throw new PushPathError("the workspace is still being restored");
    try {
      return await pushOne(this.#s, rel);
    } catch (error) {
      if (error instanceof PushPathError) throw error;
      warn(this.#s, "push of one file failed", error);
      throw new PushPathError(`${rel} could not be pushed to the Kobe server`);
    }
  }

  /** One pull now (tests). */
  pull(): Promise<number> {
    return serial(this.#s, () => pull(this.#s));
  }

  /** Resolves once the startup restore succeeded. */
  ready(): Promise<void> {
    return this.#ready ?? Promise.resolve();
  }

  /** Who hears about conflict copies (the agent reports them to the server, KOBE-492). */
  set conflictListener(listener: ConflictListener | undefined) {
    this.#s.conflictListener = listener;
  }

  /** `WorkspaceHooks.onConflict` (agent.ts). */
  onConflict(listener: ConflictListener): void {
    this.#s.conflictListener = listener;
  }
}
