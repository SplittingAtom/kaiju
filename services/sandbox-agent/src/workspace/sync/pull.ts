import { WORKSPACE_SERVER_OWNED_PREFIXES } from "@kaiju/protocol";
import { type WorkspaceEntry } from "@kaiju/protocol/sandbox-wire";
import { hashFile, lockServerOwned, pruneEmptyParents, removeFile, statLocal } from "../fs.js";
import { applyPulledCheckouts, conflictCopy, downloadSafely, revertFolder } from "./local.js";
import { rekey, replayMoves } from "./move-replay.js";
import { manifestSince } from "./restore.js";
import { isTransient, known, locked, sameAs, type SyncState } from "./state.js";

export async function pull(s: SyncState): Promise<number> {
  // Moves first, as local renames of whole trees (KOBE-304): their rows then find the files.
  rekey(
    s,
    (await replayMoves(s, s.seenRev)).filter((m) => m.now),
  );
  const { head, entries, full, checkouts } = await manifestSince(s, s.seenRev);
  const ended = await applyPulledCheckouts(s, checkouts, false);
  let applied = 0;
  if (full && s.seenRev > 0) applied += await dropUnlisted(s, entries, head);
  for (const [path, e] of [...s.retry]) {
    if (entries.some((n) => n.path === path)) continue; // a newer row is in this pull
    if (await downloadSafely(s, e)) applied += 1;
  }
  const touchedOwned =
    entries.some((e) => locked(s, e.path)) || [...s.deferred.keys()].some((p) => locked(s, p));
  // Rows deferred by an earlier pull, unless this one has a newer row for the path.
  for (const [path, e] of [...s.deferred]) {
    if (entries.some((n) => n.path === path)) s.deferred.delete(path);
    else applied += await applyGuarded(s, e);
  }
  for (const e of entries) applied += await applyGuarded(s, e);
  // An ended checkout: the restore rule brings the folder back to the head the server sent.
  for (const slug of ended) await revertFolder(s, `projects/${slug}`);
  if (touchedOwned || ended.length > 0) {
    await lockServerOwned(s.o.root, WORKSPACE_SERVER_OWNED_PREFIXES, s.checkouts);
  }
  s.seenRev = Math.max(s.seenRev, head);
  await s.moves.save(s.seenRev);
  return applied;
}

/**
 * One pulled row; a local failure that says nothing about the server (an unreadable folder,
 * CODE-25 review) defers this row to later pulls instead of stopping the pull. Transient errors
 * are rethrown (the whole step is retried).
 */
async function applyGuarded(s: SyncState, e: WorkspaceEntry): Promise<number> {
  try {
    const applied = await applyEntry(s, e);
    s.deferred.delete(e.path);
    return applied;
  } catch (error) {
    if (isTransient(error)) throw error;
    s.deferred.set(e.path, e);
    s.o.logger.warn(
      { path: e.path, code: (error as NodeJS.ErrnoException).code },
      "workspace entry not applied (kept the local state; retried later)",
    );
    return 0;
  }
}

/** The pull rule for one row; 1 when it changed something locally. */
async function applyEntry(s: SyncState, e: WorkspaceEntry): Promise<number> {
  const k = s.known.get(e.path);
  if (k && !k.moved && k.rev >= e.rev) return 0; // our own write, or already applied
  const file = await statLocal(s.o.root, e.path);
  const unchanged =
    file === undefined
      ? k === undefined || k.deleted
      : k !== undefined && !k.deleted && sameAs(file, k);
  const owned = locked(s, e.path);
  if (e.deleted) {
    if (file && (unchanged || owned)) {
      await removeFile(s.o.root, e.path, s.checkouts);
      // A server move or delete leaves no empty folders behind (KOBE-304).
      if (e.origin === "server" && !owned) {
        await pruneEmptyParents(s.o.root, e.path, s.checkouts);
      }
    }
    s.known.set(e.path, known(e));
    return 1;
  }
  if (file && !owned && k?.moved && !k.deleted && k.rev > e.rev) {
    // A commit to the old path landed after the move (a push that raced it, review R2): the
    // renamed local file is newer than the moved row. Keep it; it is pushed onto this row.
    s.known.set(e.path, known(e));
    return 0;
  }
  if (file && !owned && k && !k.deleted && k.sha256 !== undefined && k.sha256 === e.sha256) {
    // The server's content is what this file was synced from (a moved file renamed here, or
    // a row that changed only in revision): nothing to download. A local edit stays newer
    // work, pushed onto this revision.
    s.known.set(e.path, known(unchanged ? { ...e, mtime_ms: file.mtimeMs } : e));
    return 0;
  }
  if (file && !unchanged && !owned) {
    const local = await hashFile(s.o.root, e.path);
    if (local?.sha256 === e.sha256) {
      s.known.set(e.path, known({ ...e, mtime_ms: file.mtimeMs }));
      return 0;
    }
    await conflictCopy(s, e.path, e.sha256);
  }
  return (await downloadSafely(s, e)) ? 1 : 0;
}

/**
 * After a resync (our revision fell behind the server's horizon: its tombstones were purged), a
 * known path absent from the full listing was deleted on the server. Same rule as a tombstone:
 * the local file goes if it is still the version we knew (always in read-only areas); a local
 * modification is kept and pushed as a new file.
 */
export async function dropUnlisted(
  s: SyncState,
  entries: readonly WorkspaceEntry[],
  head: number,
): Promise<number> {
  const listed = new Set(entries.map((e) => e.path));
  let dropped = 0;
  for (const [path, k] of [...s.known]) {
    if (k.deleted || listed.has(path) || s.retry.has(path) || s.deferred.has(path)) continue;
    try {
      const file = await statLocal(s.o.root, path);
      if (file && !sameAs(file, k) && !locked(s, path)) {
        s.known.delete(path); // new work: pushed with no base
        continue;
      }
      if (file) await removeFile(s.o.root, path);
    } catch (error) {
      if (isTransient(error)) throw error;
      // Unreadable here (CODE-25 review): kept as it is, never dropped on a guess.
      s.o.logger.warn(
        { path, code: (error as NodeJS.ErrnoException).code },
        "workspace file not dropped: its local state could not be read",
      );
      continue;
    }
    s.known.set(path, { ...k, deleted: true, rev: head });
    dropped += 1;
  }
  return dropped;
}
