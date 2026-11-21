import {
  FILE_SHARE_MAX_BYTES,
  WORKSPACE_SERVER_OWNED_PREFIXES,
  isExcludedPath,
  type WorkspaceChange,
  type WorkspaceChangeResult,
  type WorkspaceEntry,
} from "@kobe/protocol";
import { constants as FS } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { SyncHttpError } from "../client.js";
import {
  hashFile,
  lockServerOwned,
  openForUpload,
  scanWorkspace,
  statLocal,
  type LocalFile,
} from "../fs.js";
import { conflictCopy, downloadSafely, revertLocal } from "./local.js";
import {
  COMMIT_BATCH,
  MISSING_BATCH,
  known,
  locked,
  parallel,
  sameAs,
  serial,
  warn,
  type PlannedChange,
  type PushPlan,
  type SyncState,
} from "./state.js";
import { PushPathError, type PushedFile, type PushStats } from "./types.js";

export async function pushOne(s: SyncState, rel: string): Promise<PushedFile> {
  const planned = await serial(s, async () => {
    const hashed = await hashFile(s.o.root, rel);
    const local = await statLocal(s.o.root, rel);
    if (hashed === undefined || local === undefined || hashed.size !== local.size) {
      throw new PushPathError(`${rel} is not a readable regular file (or it is changing)`);
    }
    if (hashed.size > FILE_SHARE_MAX_BYTES) throw new PushPathError(`${rel} is too large`);
    const k = s.known.get(rel);
    if (k && !k.deleted && k.sha256 === hashed.sha256) {
      return { done: { path: rel, rev: k.rev, sha256: hashed.sha256, size: hashed.size } };
    }
    if (locked(s, rel)) {
      throw new PushPathError(`${rel} is in a read-only area and differs from the server's copy`);
    }
    const change: PlannedChange = {
      op: "put",
      path: rel,
      base_rev: k?.rev ?? null,
      sha256: hashed.sha256,
      size: hashed.size,
      mtime_ms: local.mtimeMs,
      executable: local.executable,
      local,
    };
    const missing = await s.o.client.missing([hashed.sha256]);
    return { change, upload: missing.length > 0 };
  });
  if ("done" in planned) return planned.done;
  const { change } = planned;
  if (planned.upload) {
    await s.o.client.upload(change.sha256, await openForUpload(s.o.root, rel), change.size);
  }
  const outcome = await serial(s, async () => {
    if ((s.known.get(rel)?.rev ?? null) !== change.base_rev) return "stale";
    const { local: _local, ...wire } = change;
    const out = await s.o.client.commit([wire]);
    const result = out.results[0];
    if (result === undefined) return "no result";
    let refused = false;
    await applyResult(
      s,
      change,
      result,
      () => {},
      () => (refused = true),
    );
    if (refused) return "refused";
    const k = s.known.get(rel);
    return k && !k.deleted && k.sha256 === change.sha256 ? k : "newer";
  });
  if (typeof outcome === "string") {
    throw new PushPathError(
      outcome === "newer"
        ? `${rel} was changed on the server meanwhile; your copy was kept beside it`
        : `${rel} could not be synced (${outcome}); try again`,
    );
  }
  return { path: rel, rev: outcome.rev, sha256: change.sha256, size: change.size };
}

/**
 * A file a tool made owner-only (KOBE-71: tools run under Pi identities, the agent reads the
 * workspace through its group) cannot be pushed: say so once per path, never treat it as gone.
 */
export async function noteUnreadable(s: SyncState, path: string): Promise<void> {
  if (s.unreadable.has(path)) return;
  try {
    await access(join(s.o.root, path), FS.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") return;
    if (s.unreadable.size < 1000) s.unreadable.add(path);
    warn(
      s,
      `workspace file not synced: ${path} is not readable by the agent (owner-only mode)`,
      error,
    );
  }
}

/**
 * Plan under the lock (scan, hash, revert read-only areas, ask what content the server lacks),
 * upload outside it (a large upload never holds up a run's pull), commit under it again —
 * dropping any change whose path a pull touched meanwhile (the next push recomputes it).
 */
export async function push(s: SyncState): Promise<PushStats> {
  const stats = { changes: 0, uploaded: 0, bytes: 0, conflicts: 0, rejected: 0 };
  const plan = await serial(s, () => planPush(s));
  stats.changes = plan.changes.length;
  if (plan.changes.length === 0 && plan.resends.length === 0) return stats;
  const failed = new Set<string>();
  const queued = new Set(plan.uploads.map((c) => (c.op === "put" ? c.sha256 : "")));
  const uploads = [
    ...plan.uploads,
    ...plan.resends.filter((c) => c.op === "put" && !queued.has(c.sha256)),
  ];
  await parallel(uploads, Math.min(4, s.o.concurrency), async (c) => {
    if (c.op !== "put") return;
    try {
      await s.o.client.upload(c.sha256, await openForUpload(s.o.root, c.path), c.size);
      stats.uploaded += 1;
      stats.bytes += c.size;
    } catch (error) {
      failed.add(c.sha256);
      // 413: too large for good (until the file changes). 507 (budget full) is retried next
      // push: collection frees room.
      if (error instanceof SyncHttpError && error.status === 413 && c.local) {
        s.refused.set(c.path, c.local);
        stats.rejected += 1;
      } else {
        // 409: content being collected, 422 or a body-length error: the file changed while
        // uploading; anything else: logged. This file waits for the next push, the rest goes on.
        warn(s, "workspace upload failed for one file", error);
      }
    }
  });
  const ready = plan.changes.filter((c) => c.op === "delete" || !failed.has(c.sha256));
  if (ready.length === 0) return stats;
  const committed = await serial(s, () => commit(s, ready));
  return {
    ...stats,
    conflicts: committed.conflicts,
    rejected: stats.rejected + committed.rejected,
  };
}

export async function planPush(s: SyncState): Promise<PushPlan> {
  const scan = await scanWorkspace(s.o.root, {
    skipDirs: s.o.skipDirs,
    maxFiles: s.o.maxFiles,
  });
  const changes: PlannedChange[] = [];
  let reverted = false;
  // Symlinks, special files and names the sync refuses stay local only (KOBE-733).
  let leftOut = scan.skipped;
  for (const [path, file] of scan.files) {
    const k = s.known.get(path);
    if (locked(s, path)) {
      if (await revertLocal(s, path, file)) reverted = true;
      continue;
    }
    if (k && !k.deleted && sameAs(file, k) && file.executable === k.executable) continue;
    const refused = s.refused.get(path);
    if (refused && sameAs(file, refused)) {
      leftOut += 1;
      continue;
    }
    const hashed = await hashFile(s.o.root, path);
    if (!hashed) {
      leftOut += 1;
      await noteUnreadable(s, path);
      continue; // changing right now, or unreadable: next time
    }
    if (hashed.size !== file.size) {
      leftOut += 1;
      continue; // changing right now: next time
    }
    changes.push({
      op: "put",
      path,
      base_rev: k?.rev ?? null,
      sha256: hashed.sha256,
      size: hashed.size,
      mtime_ms: file.mtimeMs,
      executable: file.executable,
      local: file,
    });
  }
  const unsure = (path: string) =>
    scan.truncated || scan.incomplete.some((d) => d === "" || path.startsWith(`${d}/`));
  for (const [path, k] of s.known) {
    if (k.deleted || scan.files.has(path) || isExcludedPath(path) || unsure(path)) continue;
    if (s.retry.has(path) || s.deferred.has(path)) continue; // not settled yet: never a deletion
    if (path.split("/").some((part) => s.o.skipDirs.has(part))) continue;
    if (locked(s, path)) {
      await revertLocal(s, path, undefined);
      reverted = true;
      continue;
    }
    changes.push({ op: "delete", path, base_rev: k.rev });
  }
  if (reverted) {
    await lockServerOwned(s.o.root, WORKSPACE_SERVER_OWNED_PREFIXES, s.checkouts);
  }
  const hashes = [...new Set(changes.flatMap((c) => (c.op === "put" ? [c.sha256] : [])))];
  const missing = new Set<string>();
  for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
    for (const h of await s.o.client.missing(hashes.slice(i, i + MISSING_BATCH))) {
      missing.add(h);
    }
  }
  const seen = new Set<string>();
  const uploads = changes.filter((c) => {
    if (c.op !== "put" || !missing.has(c.sha256) || seen.has(c.sha256)) return false;
    seen.add(c.sha256);
    return true;
  });
  return {
    changes,
    uploads,
    resends: await resends(s, scan.files, changes),
    leftOut,
    partialScan: scan.truncated || scan.incomplete.length > 0,
  };
}

/**
 * Lost content this volume still holds (KOBE-475): for each hash the server lists, one known
 * path whose file is unchanged since it synced (size + mtime) and still hashes to it. Files
 * with local changes are in `changes` already (a push names their content and uploads it).
 */
export async function resends(
  s: SyncState,
  files: ReadonlyMap<string, LocalFile>,
  changes: readonly PlannedChange[],
): Promise<PlannedChange[]> {
  let lost: string[];
  try {
    lost = await s.o.client.lost();
  } catch (error) {
    // Never holds up the push: asked again next time.
    warn(s, "could not ask which workspace content to resend", error);
    return [];
  }
  if (lost.length === 0) return [];
  const wanted = new Set(lost);
  const changing = new Set(changes.map((c) => c.path));
  const resends: PlannedChange[] = [];
  for (const [path, k] of s.known) {
    if (k.deleted || k.sha256 === undefined || !wanted.has(k.sha256) || changing.has(path)) {
      continue;
    }
    const file = files.get(path);
    if (!file || !sameAs(file, k)) continue;
    const hashed = await hashFile(s.o.root, path);
    if (hashed?.sha256 !== k.sha256 || hashed.size !== file.size) continue;
    wanted.delete(k.sha256);
    resends.push({
      op: "put",
      path,
      base_rev: k.rev,
      sha256: k.sha256,
      size: hashed.size,
      mtime_ms: file.mtimeMs,
      executable: file.executable,
      local: file,
    });
  }
  if (resends.length > 0) {
    s.o.logger.info({ files: resends.length }, "resending workspace content the server lost");
  }
  return resends;
}

export async function commit(
  s: SyncState,
  planned: readonly PlannedChange[],
): Promise<{ conflicts: number; rejected: number }> {
  let conflicts = 0;
  let rejected = 0;
  // A pull may have moved a path since the plan: its base is stale, recompute next time.
  const ready = planned.filter((c) => (s.known.get(c.path)?.rev ?? null) === c.base_rev);
  for (let i = 0; i < ready.length; i += COMMIT_BATCH) {
    const batch = ready.slice(i, i + COMMIT_BATCH);
    const out = await s.o.client.commit(batch.map(({ local: _l, ...change }) => change));
    for (const [j, result] of out.results.entries()) {
      const change = batch[j];
      if (!change) continue;
      // One path's local trouble (a name, a link) never abandons the other results.
      try {
        await applyResult(
          s,
          change,
          result,
          () => (conflicts += 1),
          () => (rejected += 1),
        );
      } catch (error) {
        s.known.delete(change.path); // recomputed from scratch on the next push
        warn(s, "could not apply a commit result for one file", error);
      }
    }
  }
  return { conflicts, rejected };
}

export async function applyResult(
  s: SyncState,
  change: PlannedChange,
  result: WorkspaceChangeResult,
  conflict: () => void,
  reject: () => void,
): Promise<void> {
  if (result.status === "applied") {
    s.known.set(result.path, known(result.entry));
    s.refused.delete(result.path);
  } else if (result.status === "noop") {
    s.known.delete(result.path);
  } else if (result.status === "conflict") {
    conflict();
    await resolveConflict(s, change, result.current);
  } else {
    reject();
    if (result.code !== "missing_blob" && change.local) {
      s.refused.set(result.path, change.local);
    }
    s.o.logger.warn({ code: result.code }, "workspace change refused by the server");
  }
}

/** The server's newer version keeps the path; the local edit becomes a conflict copy. */
export async function resolveConflict(
  s: SyncState,
  change: WorkspaceChange,
  current: WorkspaceEntry | undefined,
): Promise<void> {
  if (current === undefined || current.deleted) {
    // Deleted meanwhile: our modification wins on top of the tombstone (next push).
    if (current) s.known.set(change.path, known(current));
    else s.known.delete(change.path);
    return;
  }
  if (change.op === "put") {
    // Our own earlier write whose answer was lost, or identical content: adopt it.
    const local = await hashFile(s.o.root, change.path);
    if (local !== undefined && local.sha256 === current.sha256) {
      const file = await statLocal(s.o.root, change.path);
      s.known.set(change.path, known({ ...current, mtime_ms: file?.mtimeMs ?? current.mtime_ms }));
      return;
    }
    await conflictCopy(s, change.path, current.sha256);
  }
  await downloadSafely(s, current);
}
