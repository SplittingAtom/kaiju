// Local file operations shared by the restore, pull and push steps of workspace sync.
import type { WorkspaceEntry } from "@kobe/protocol";
import { applyCheckouts } from "../checkouts.js";
import {
  conflictCopyName,
  ensureParents,
  entryExists,
  hashFile,
  removeFile,
  renameWithin,
  scanWorkspace,
  writeFileAtomic,
  type Checkouts,
  type LocalFile,
} from "../fs.js";
import { EVICTED_PREFIX } from "./types.js";
import { isTransient, known, locked, modeFor, sameAs, warn, type SyncState } from "./state.js";

/** The checkouts of a pull take effect (CM4, `checkouts.ts`); returns the slugs that left. */
export async function applyPulledCheckouts(
  s: SyncState,
  next: Checkouts,
  everyFolder: boolean,
  executable: (rel: string) => boolean = (rel) => s.known.get(rel)?.executable === true,
): Promise<string[]> {
  const previous = s.checkouts;
  s.checkouts = next;
  const ended = await applyCheckouts(
    {
      root: s.o.root,
      executable,
      known: (rel) => s.known.has(rel),
      remove: (rel) => removeFile(s.o.root, rel, next),
      evict: (rel) => evict(s, rel),
    },
    previous,
    next,
    everyFolder,
  );
  if (!everyFolder && ended.length > 0) {
    s.o.logger.info({ projects: ended.length }, "project checkout ended: folder relocked");
  }
  return ended;
}

export async function download(s: SyncState, path: string): Promise<{ size: number } | undefined> {
  const got = await s.o.client.download(path);
  if (!got) {
    s.known.delete(path); // gone meanwhile; the next pull brings its tombstone
    return undefined;
  }
  const { entry, body } = got;
  await writeFileAtomic(
    s.o.root,
    path,
    body,
    {
      sha256: entry.sha256 ?? "",
      size: entry.size,
      mtimeMs: entry.mtime_ms,
      mode: modeFor(locked(s, path), entry.executable),
    },
    s.checkouts,
  );
  s.known.set(path, known(entry));
  return { size: entry.size };
}

/**
 * One file's download, failing only that file: a missing object or something local in the way
 * (a directory where the copy has a file) is logged and retried on later pulls, keeping the
 * local data; a server or network failure is rethrown (the whole step is retried).
 */
export async function downloadSafely(
  s: SyncState,
  e: WorkspaceEntry,
): Promise<{ size: number } | undefined> {
  try {
    const got = await download(s, e.path);
    s.retry.delete(e.path);
    return got;
  } catch (error) {
    if (isTransient(error)) throw error;
    s.retry.set(e.path, e);
    // Nothing to push or delete for this path until it is resolved.
    if (!s.known.has(e.path)) s.known.set(e.path, { ...known(e), rev: e.rev - 1 });
    warn(s, "workspace file not restored (kept the local state; retried later)", error);
    return undefined;
  }
}

/**
 * A file in a server-owned area the server never wrote (or a tool's folder or link left in an
 * ended checkout): moved to `kobe-moved/…`, never lost.
 */
export async function evict(s: SyncState, path: string): Promise<void> {
  let target = `${EVICTED_PREFIX}${path}`;
  if (await entryExists(s.o.root, target)) {
    target = await conflictCopyName(s.o.root, target, s.o.now());
  }
  try {
    await ensureParents(s.o.root, target);
    await ensureParents(s.o.root, path, s.checkouts); // the read-only parent: writable
    await renameWithin(s.o.root, path, target);
    s.o.logger.info({}, "moved a file out of a read-only workspace area");
  } catch (error) {
    warn(s, "could not move a file out of a read-only area", error);
  }
}

/**
 * The local edit at `path` becomes a conflict copy; `memberSha256` is the server version that
 * keeps the path. Reported (KOBE-492) when both versions are known: names and hashes only.
 */
export async function conflictCopy(
  s: SyncState,
  path: string,
  memberSha256: string | undefined,
): Promise<void> {
  const now = s.o.now();
  const agent = await hashFile(s.o.root, path).catch(() => undefined);
  const copy = await conflictCopyName(s.o.root, path, now);
  await renameWithin(s.o.root, path, copy);
  s.o.logger.info({}, "workspace conflict: kept the local version as a conflict copy");
  if (memberSha256 === undefined || agent === undefined) return;
  try {
    s.conflictListener?.({
      path,
      conflict_path: copy,
      member_sha256: memberSha256,
      agent_sha256: agent.sha256,
      at: now,
    });
  } catch (error) {
    warn(s, "could not report a workspace conflict", error);
  }
}

/**
 * The read-only area's rule for one path (`file`: its local state, undefined when missing):
 * a file the server never wrote is moved out, a local edit or deletion is undone with the
 * server's version. True when something changed.
 */
export async function revertLocal(
  s: SyncState,
  path: string,
  file: LocalFile | undefined,
): Promise<boolean> {
  const k = s.known.get(path);
  if (file !== undefined && (!k || k.deleted)) {
    await evict(s, path);
    return true;
  }
  if (k === undefined || k.deleted || (file !== undefined && sameAs(file, k))) return false;
  await download(s, path).catch((error: unknown) => warn(s, "revert failed", error));
  return true;
}

/** {@link #revertLocal} over one folder (an ended checkout): it then matches the head. */
export async function revertFolder(s: SyncState, folder: string): Promise<void> {
  const scan = await scanWorkspace(s.o.root, {
    skipDirs: s.o.skipDirs,
    maxFiles: s.o.maxFiles,
    from: folder,
  });
  for (const [path, file] of scan.files) await revertLocal(s, path, file);
  if (scan.truncated || scan.incomplete.length > 0) return; // never infer a missing file
  for (const [path, k] of [...s.known]) {
    if (k.deleted || !path.startsWith(`${folder}/`) || scan.files.has(path)) continue;
    if (s.retry.has(path)) continue;
    await revertLocal(s, path, undefined);
  }
}
