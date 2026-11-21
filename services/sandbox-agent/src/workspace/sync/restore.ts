import {
  WORKSPACE_SERVER_OWNED_PREFIXES,
  isExcludedPath,
  workspacePathIssue,
  type WorkspaceEntry,
} from "@kobe/protocol";
import { SyncHttpError } from "../client.js";
import {
  hashFile,
  lockServerOwned,
  removeFile,
  scanWorkspace,
  type Checkouts,
  type LocalFile,
} from "../fs.js";
import { applyPulledCheckouts, conflictCopy, downloadSafely, evict } from "./local.js";
import { replayMoves } from "./move-replay.js";
import { loadStamps, sameStamp } from "./stamps.js";
import {
  UNAVAILABLE_RETRY_MS,
  known,
  locked,
  parallel,
  sameAs,
  serial,
  warn,
  type Known,
  type SyncState,
} from "./state.js";
import type { RestoreStats } from "./types.js";

export async function restoreUntilDone(s: SyncState): Promise<void> {
  for (let attempt = 0; !s.stopped; attempt++) {
    try {
      const stats = await serial(s, () => restore(s));
      s.restored = true;
      s.unavailable = false;
      s.o.logger.info({ ...stats }, "workspace restored");
      await s.o.client
        .restoreReport({
          mode: stats.mode,
          files: stats.files,
          bytes: stats.bytes,
          duration_ms: stats.durationMs,
        })
        .catch((error: unknown) => warn(s, "workspace restore report failed", error));
      return;
    } catch (error) {
      let delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random());
      if (error instanceof SyncHttpError && error.status === 404 && error.code !== "not_found") {
        // This server has no workspace sync (no object storage configured, or a replica from
        // before it): off for now, asked again later (runs do not wait meanwhile).
        if (!s.unavailable) s.o.logger.warn({}, "workspace sync is not available");
        s.unavailable = true;
        s.settle();
        delay = UNAVAILABLE_RETRY_MS;
      } else {
        warn(s, "workspace restore failed; retrying", error);
      }
      await new Promise((r) => setTimeout(r, delay).unref());
    }
  }
}

/**
 * Entries since a revision; `full` when this is a complete listing (from 0, or the server said
 * our revision is older than its horizon) — then a path missing from it no longer exists.
 */
export async function manifestSince(
  s: SyncState,
  since: number,
): Promise<{
  head: number;
  entries: WorkspaceEntry[];
  full: boolean;
  checkouts: Checkouts;
}> {
  const entries: WorkspaceEntry[] = [];
  let cursor = since;
  for (;;) {
    let page;
    try {
      page = await s.o.client.manifest(cursor);
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === "resync_required" && cursor > 0) {
        return manifestSince(s, 0);
      }
      throw error;
    }
    // Re-checked here: a path the agent must never write (its own area, an invalid name) is
    // ignored whatever the server says.
    entries.push(
      ...page.entries.filter(
        (e) => workspacePathIssue(e.path) === undefined && !isExcludedPath(e.path),
      ),
    );
    if (!page.more || page.entries.length === 0) {
      // The last page's checkouts: the state at the end of this pull (absent = none).
      const checkouts = new Set(page.checkouts.map((c) => c.slug));
      return { head: page.head_rev, entries, full: since === 0, checkouts };
    }
    cursor = page.entries[page.entries.length - 1]?.rev ?? page.head_rev;
  }
}

export async function restore(s: SyncState): Promise<RestoreStats> {
  if (s.restoreStarted === 0) s.restoreStarted = Date.now();
  // A woken sandbox replays the moves made while it slept before comparing anything (KOBE-304).
  // Without a saved revision (a new or rebuilt volume) there is nothing local to move.
  const saved = await s.moves.savedRev();
  const moved = saved > 0 ? await replayMoves(s, saved) : [];
  const movedHere = (p: string) => moved.some(({ to }) => p === to || p.startsWith(`${to}/`));
  const { head, entries, checkouts } = await manifestSince(s, 0);
  // Checkouts first (recomputed, never stored): the scan then sees the folders as they are now.
  const executables = new Set(entries.filter((e) => e.executable && !e.deleted).map((e) => e.path));
  await applyPulledCheckouts(s, checkouts, true, (rel) => executables.has(rel));
  const local = await scanWorkspace(s.o.root, {
    skipDirs: s.o.skipDirs,
    maxFiles: s.o.maxFiles,
  });
  // What the last agent on this volume verified (KOBE-733): kept files whose stamp is unchanged.
  const verifiedBefore = await loadStamps(s.o.root);
  const verifiedKnown = (e: WorkspaceEntry, file: LocalFile): Known => {
    const v = verifiedBefore.get(e.path);
    return v && v.sha256 === e.sha256 && sameStamp(v.stamp, file.stamp)
      ? { ...known(e), stamp: v.stamp }
      : known(e);
  };
  // The newest row per path (a full listing has one per path; be safe anyway).
  const latest = new Map<string, WorkspaceEntry>();
  for (const e of entries) {
    const prev = latest.get(e.path);
    if (!prev || prev.rev < e.rev) latest.set(e.path, e);
  }
  // Whether the volume was empty when this process first looked (a retried restore sees the
  // files its failed attempt already wrote).
  s.emptyAtStart ??= local.files.size === 0;
  const empty = s.emptyAtStart;
  const downloads: WorkspaceEntry[] = [];
  for (const e of latest.values()) {
    const file = local.files.get(e.path);
    if (e.deleted) {
      // Only the deleted version itself is removed; a different local file is newer work.
      if (file && sameAs(file, { size: e.size, mtimeMs: e.mtime_ms })) {
        await removeFile(s.o.root, e.path);
      }
      s.known.set(e.path, known(e));
      continue;
    }
    if (file && sameAs(file, { size: e.size, mtimeMs: e.mtime_ms })) {
      s.known.set(e.path, verifiedKnown(e, file));
      continue;
    }
    if (!file || locked(s, e.path)) {
      downloads.push(e);
      continue;
    }
    if (movedHere(e.path)) {
      // Renamed here from its old path (by this attempt or an earlier one, review R1). Moved
      // rows keep the source's mtime: a local file newer than the row is an edit made since the
      // last sync, kept and pushed onto this row; an older one lost to a newer server version
      // (an upload made while the sandbox slept) and is kept beside it as a conflict copy.
      s.known.set(e.path, known(e));
      if (file.mtimeMs > e.mtime_ms) continue;
      if ((await hashFile(s.o.root, e.path))?.sha256 === e.sha256) continue;
      await conflictCopy(s, e.path, e.sha256);
      downloads.push(e);
      continue;
    }
    // The volume and the copy differ. A sandbox-written row: the volume is newer work, keep it
    // (pushed next, based on this row). A server-written row (uploads, file browser): the
    // server's version wins unless the local file changed after it — then keep both.
    s.known.set(e.path, known(e));
    if (e.origin === "server") {
      if (file.mtimeMs > e.updated_ms) await conflictCopy(s, e.path, e.sha256);
      downloads.push(e);
    }
  }
  await parallel(downloads, s.o.concurrency, async (e) => {
    const got = await downloadSafely(s, e);
    if (got) {
      s.restoredFiles += 1;
      s.restoredBytes += got.size;
    }
  });
  // Server-owned areas mirror the server: what it never wrote is moved out (kept, then pushed).
  for (const path of local.files.keys()) {
    if (locked(s, path) && !latest.has(path)) await evict(s, path);
  }
  await lockServerOwned(s.o.root, WORKSPACE_SERVER_OWNED_PREFIXES, s.checkouts);
  s.seenRev = head;
  await s.moves.save(head);
  const files = s.restoredFiles;
  return {
    mode: empty && files > 0 ? "full" : "incremental",
    entries: latest.size,
    files,
    bytes: s.restoredBytes,
    durationMs: Date.now() - s.restoreStarted,
  };
}
