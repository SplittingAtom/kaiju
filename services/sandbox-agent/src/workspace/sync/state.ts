import type { WorkspaceChange, WorkspaceEntry } from "@kobe/protocol";
import { SyncHttpError } from "../client.js";
import { isLockedPath, type Checkouts, type LocalFile } from "../fs.js";
import type { MoveReplay } from "../moves.js";
import type { FileStamp } from "./stamps.js";
import type { ConflictListener, WorkspaceSyncOptions } from "./types.js";

/** Last known state of a path in the durable copy (what the local file was synced from). */
export interface Known {
  readonly rev: number;
  readonly deleted: boolean;
  readonly sha256?: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly executable: boolean;
  readonly origin: "sandbox" | "server";
  readonly updatedMs: number;
  /**
   * Carried here by a local rename (KOBE-304): `rev` is the old path's, so it must not shadow the
   * new path's rows (review R2); the next row of this path replaces it.
   */
  readonly moved?: true;
  /**
   * KOBE-733: the local file's stamp when it was last verified to hold this content (pushed from
   * it, re-hashed equal, or remembered on the volume), outside the racy window. Absent: the file
   * is unverified and re-hashed before it counts as unchanged for the proof.
   */
  readonly stamp?: FileStamp;
}

export const COMMIT_BATCH = 250;
export const MISSING_BATCH = 1000;
export const UNAVAILABLE_RETRY_MS = 5 * 60_000;

/** Errors that say nothing about one file: the server or the network. Retry the whole step. */
export function isTransient(error: unknown): boolean {
  if (error instanceof SyncHttpError) {
    return (
      error.status === 0 || error.status === 429 || (error.status >= 500 && error.status !== 502)
    );
  }
  return error instanceof TypeError; // fetch: network failure
}

export const known = (e: WorkspaceEntry): Known => ({
  rev: e.rev,
  deleted: e.deleted,
  ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }),
  size: e.size,
  mtimeMs: e.mtime_ms,
  executable: e.executable,
  origin: e.origin,
  updatedMs: e.updated_ms,
});

/** Size and mtime match (the rsync heuristic: no need to read the file). */
export const sameAs = (local: LocalFile, k: { size: number; mtimeMs: number }) =>
  local.size === k.size && Math.abs(local.mtimeMs - k.mtimeMs) <= 1;

/** Group-writable: every thread's Pi identity shares the workspace through its group (KOBE-71). */
export const modeFor = (locked: boolean, executable: boolean) =>
  locked ? 0o444 : executable ? 0o775 : 0o664;

/** Runs `fn` over `items`, `limit` at a time; waits for all, then rethrows the first failure. */
export async function parallel<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/**
 * `local`: the scanned file the content was read from; `verifiable` (KOBE-733): its stamp was
 * outside the racy window when hashing started, so it may be recorded once the push lands.
 */
export type PlannedChange = WorkspaceChange & {
  readonly local?: LocalFile;
  readonly verifiable?: true;
};

export interface PushPlan {
  readonly changes: PlannedChange[];
  /** Content to upload (one change per hash). */
  readonly uploads: PlannedChange[];
  /**
   * Unchanged files whose content the server lost from storage (KOBE-475): uploaded again, never
   * committed (their rows already point at that content).
   */
  readonly resends: PlannedChange[];
  /**
   * Local files this plan left out: refused earlier and unchanged since, unreadable, or changing
   * while hashed (KOBE-733: a push is complete only when this is 0 and the scan was whole).
   */
  readonly leftOut: number;
  /** The scan stopped early (file cap) or could not read a folder: deletions were not inferred. */
  readonly partialScan: boolean;
  /** Files re-hashed equal but too young to record (racy window): verified on a later pass. */
  readonly unverified: number;
  /** Files whose content this plan re-hashed only to verify them (unchanged size and mtime). */
  readonly rehashed: number;
}

export type ResolvedSyncOptions = Required<Omit<WorkspaceSyncOptions, "skipDirs">> & {
  skipDirs: Set<string>;
};

/**
 * The state `WorkspaceSync` shares with the restore, pull and push steps (`restore.ts`,
 * `pull.ts`, `push.ts`): one object, owned by the class and passed to every step, so the steps
 * stay plain functions and nothing of it is public on the class.
 */
export interface SyncState {
  readonly o: ResolvedSyncOptions;
  readonly known: Map<string, Known>;
  /** Local states the server refused (size/quota): not retried until the file changes. */
  readonly refused: Map<string, LocalFile>;
  /** Paths already reported unreadable (bounded). */
  readonly unreadable: Set<string>;
  /** Downloads that failed for this file only (missing object, something local in the way). */
  readonly retry: Map<string, WorkspaceEntry>;
  /**
   * Pulled rows whose local state could not be read (an unreadable folder, CODE-25 review):
   * evaluated again on later pulls, with the full rule (conflict copies, tombstones).
   */
  readonly deferred: Map<string, WorkspaceEntry>;
  /** Server moves replayed as local renames (KOBE-304). */
  readonly moves: MoveReplay;
  seenRev: number;
  chain: Promise<unknown>;
  /** Settles `WorkspaceSync.ready()`. */
  settle: () => void;
  restored: boolean;
  stopped: boolean;
  conflictListener: ConflictListener | undefined;
  unavailable: boolean;
  emptyAtStart: boolean | undefined;
  /** Files and bytes downloaded by restore attempts so far. */
  restoredFiles: number;
  restoredBytes: number;
  /** Files re-hashed only to verify them, over this agent's life (KOBE-733; diagnostics). */
  rehashed: number;
  restoreStarted: number;
  /** Slugs of the member's project checkouts, as the latest pull listed them (CM4). */
  checkouts: Checkouts;
}

/** Read-only here: a server-owned area outside the member's checkouts. */
export function locked(s: SyncState, path: string): boolean {
  return isLockedPath(path, s.checkouts);
}

export function serial<T>(s: SyncState, fn: () => Promise<T>): Promise<T> {
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => {});
  return run;
}

export function warn(s: SyncState, message: string, error: unknown): void {
  s.o.logger.warn({ err: error instanceof Error ? error.message : String(error) }, message);
}
