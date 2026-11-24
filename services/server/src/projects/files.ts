import { randomUUID } from "node:crypto";
import { pipeline, type Readable } from "node:stream";
import {
  and,
  asc,
  eq,
  projectFiles,
  projects,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  PROJECT_FILES_MAX,
  PROJECT_FILE_MAX_BYTES,
  workspacePathSchema,
  type ProjectFile,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { UploadMeter, UploadTooLargeError } from "../uploads/meter.js";
import { clashesInTree, fitsMount } from "./paths.js";
import { checkLimitsAfterWrite, DEFAULT_TEAM_MAX_OBJECTS, OverLimit } from "./storage.js";
import { commitFiles, queueProjectBlobs } from "./tree.js";
import { projectWriteBlock } from "./repo-state.js";

/**
 * Project files (KOBE-162, D23): the project's own copy of each file lives in object storage at
 * `<prefix>teams/<team>/projects/<project>/files/<file id>` (not a thread tree: no thread purge
 * touches it) and is described by one `project_files` row. {@link ProjectMounts} makes the rows
 * visible read-only in members' workspaces. Upload bytes stream through a staging object (bounded
 * memory, hash and size known at the end), are copied to their key, and the row, the team storage
 * quota check and the audit event commit together. Both keys are reserved for the blob deleter
 * before the first byte (KOBE-740), so a crash in between leaves no permanent object. Names and paths never reach the audit log.
 */
export type ProjectFileFailure =
  | "invalid_path"
  | "path_too_long"
  | "already_exists"
  | "path_clash"
  | "file_too_large"
  | "quota_exceeded"
  | "object_budget"
  | "project_full"
  | "archived"
  | "storage_failed"
  /** KOBE-765: a Repo (G17) or a project being converted takes no file changes from Kaiju. */
  | "repo"
  | "converting";

export type FileOutcome =
  | { readonly ok: true; readonly file: ProjectFile }
  | { readonly ok: false; readonly error: ProjectFileFailure };

export interface ProjectFileDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  /** Site defaults: largest single file and the team storage quota default. */
  readonly maxFileBytes: number;
  readonly teamQuotaDefaultBytes: number;
  /** Site default of the object budget (GV2); default {@link DEFAULT_TEAM_MAX_OBJECTS}. */
  readonly teamMaxObjectsDefault?: number;
}

/** Add to project (KOBE-585): what a file was copied from, for the audit row (ids only). */
export type ImportedFrom =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly version: number }
  | { readonly kind: "workspace_file" };

export interface FileTarget {
  readonly teamId: string;
  readonly projectId: string;
  /** Who adds it (the uploader, or the user whose run proposed it). */
  readonly userId: string;
}

type Row = typeof projectFiles.$inferSelect;

export const toProjectFile = (row: Row): ProjectFile => ({
  id: row.id,
  project_id: row.projectId,
  path: row.path,
  size_bytes: row.sizeBytes,
  sha256: row.sha256,
  mime_type: row.mimeType,
  source: row.source,
  added_by: row.addedBy,
  added_at: row.addedAt.toISOString(),
});

/**
 * The head files; a file whose path is too long once mounted (a row from before KOBE-780) is
 * marked `path_too_long`: it reaches no workspace until someone deletes it and adds it again.
 */
export async function listProjectFiles(
  tx: KobeTx,
  project: { readonly teamId: string; readonly id: string; readonly slug: string },
): Promise<ProjectFile[]> {
  const rows = await tx
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.teamId, project.teamId), eq(projectFiles.projectId, project.id)))
    .orderBy(asc(projectFiles.path));
  return rows.map((row) => {
    const file = toProjectFile(row);
    return fitsMount(project.slug, row.path) ? file : { ...file, path_too_long: true as const };
  });
}

/** `folder/name` inside the project, or undefined when it is not a valid workspace path. */
export function projectFilePath(folder: string | undefined, name: string): string | undefined {
  const joined = folder === undefined || folder === "" ? name : `${folder}/${name}`;
  const parsed = workspacePathSchema.safeParse(joined);
  return parsed.success ? parsed.data : undefined;
}

export const projectFileKey = (
  blobs: BlobStore,
  teamId: string,
  projectId: string,
  fileId: string,
): string => `${blobs.prefix}teams/${teamId}/projects/${projectId}/files/${fileId}`;

const stagingKey = (blobs: BlobStore, teamId: string, projectId: string): string =>
  `${blobs.prefix}teams/${teamId}/projects/${projectId}/staging/${randomUUID()}`;

/** Deletes the object (best effort); true when it is gone. */
async function discard(blobs: BlobStore, key: string): Promise<boolean> {
  try {
    await blobs.objects.delete([key]);
    return true;
  } catch (err) {
    logger.warn({ err }, "project file: could not delete an object");
    return false;
  }
}

/**
 * KOBE-740: an upload's staging and file keys are reserved in `retention_blob_deletions` (due in
 * hours, `queueProjectBlobs`) before any byte is written, so a crash between the put and the
 * commit leaves nothing the blob deleter won't take. The commit clears the file key (`writeCommit`);
 * a key deleted here is cleared too, and one that could not be deleted stays queued.
 */
async function reserve(deps: ProjectFileDeps, target: FileTarget, keys: string[]): Promise<void> {
  await withTeam(deps.db, target.teamId, (tx) =>
    queueProjectBlobs(tx, target.teamId, target.projectId, target.userId, keys, "reservation"),
  );
}

/** Discards the object and, once it is gone, drops its reservation (best effort). */
async function discardReserved(
  deps: ProjectFileDeps,
  blobs: BlobStore,
  teamId: string,
  key: string,
): Promise<void> {
  if (!(await discard(blobs, key))) return;
  try {
    await withTeam(deps.db, teamId, (tx) =>
      tx.execute(
        sql`DELETE FROM retention_blob_deletions WHERE team_id = ${teamId} AND key = ${key}`,
      ),
    );
  } catch (err) {
    // The queued row then only makes the deleter delete an absent key.
    logger.warn({ err, teamId }, "project file: could not clear a reservation");
  }
}

class Refused extends Error {
  constructor(readonly failure: ProjectFileFailure) {
    super(failure);
  }
}

/**
 * Checks and inserts the row in `tx` (the caller's transaction, project row already locked):
 * archived, the path once mounted (KOBE-780), file count, name taken, a file inside a file, and
 * after the write the team storage quota. Throws {@link Refused} (the caller rolls back).
 */
export async function insertProjectFile(
  tx: KobeTx,
  deps: Pick<ProjectFileDeps, "teamQuotaDefaultBytes" | "teamMaxObjectsDefault">,
  target: FileTarget,
  file: {
    readonly id: string;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mime: string;
    readonly blobRef: string;
    readonly source: "upload" | "proposal";
    readonly importedFrom?: ImportedFrom | undefined;
  },
): Promise<ProjectFile> {
  const { teamId, projectId, userId } = target;
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt, slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.id, projectId)))
    .for("update");
  if (!project) throw new Refused("storage_failed");
  if (project.archivedAt !== null) throw new Refused("archived");
  const block = await projectWriteBlock(tx, teamId, projectId);
  if (block !== null) throw new Refused(block);
  if (!fitsMount(project.slug, file.path)) throw new Refused("path_too_long");
  const held = new Set(
    (
      await tx
        .select({ path: projectFiles.path })
        .from(projectFiles)
        .where(and(eq(projectFiles.teamId, teamId), eq(projectFiles.projectId, projectId)))
    ).map((r) => r.path),
  );
  if (held.size >= PROJECT_FILES_MAX) throw new Refused("project_full");
  if (held.has(file.path)) throw new Refused("already_exists");
  // P2-9: the head tree never holds a file inside a file (mounts and checkouts could not write it).
  if (clashesInTree(held, file.path)) throw new Refused("path_clash");
  const [row] = await tx
    .insert(projectFiles)
    .values({
      teamId,
      id: file.id,
      projectId,
      path: file.path,
      sizeBytes: file.size,
      sha256: file.sha256,
      mimeType: file.mime,
      blobRef: file.blobRef,
      source: file.source,
      addedBy: userId,
    })
    .returning();
  if (!row) throw new Error("project_files insert returned no row");
  await recordAudit(tx, {
    action: "project.file_added",
    actor: { kind: "user", id: userId },
    teamId,
    target: {
      projectId,
      fileId: file.id,
      source: file.source,
      sizeBytes: file.size,
      ...(file.importedFrom === undefined ? {} : { importedFrom: file.importedFrom }),
    },
  });
  // Every change of the files is a commit (KOBE-579, CM1): `project_files` stays the head tree.
  await commitFiles(tx, teamId, projectId, { userId, kind: "user" }, `Add ${file.path}`);
  // The team quota under its lock, after the history aggregate (P2-44); a refusal rolls back.
  try {
    await checkLimitsAfterWrite(
      tx,
      teamId,
      {
        quotaDefaultBytes: deps.teamQuotaDefaultBytes,
        maxObjectsDefault: deps.teamMaxObjectsDefault ?? DEFAULT_TEAM_MAX_OBJECTS,
      },
      { bytes: file.size, objects: 1 },
    );
  } catch (err) {
    if (err instanceof OverLimit) {
      throw new Refused(err.limit === "bytes" ? "quota_exceeded" : "object_budget");
    }
    throw err;
  }
  return toProjectFile(row);
}

/** Commits a stored object as a project file; discards the object when the commit is refused. */
export async function commitProjectFile(
  deps: ProjectFileDeps,
  blobs: BlobStore,
  target: FileTarget,
  file: Parameters<typeof insertProjectFile>[3],
): Promise<FileOutcome> {
  try {
    const stored = await withTeam(deps.db, target.teamId, (tx) =>
      insertProjectFile(tx, deps, target, file),
    );
    return { ok: true, file: stored };
  } catch (err) {
    if (err instanceof Refused) {
      await discardReserved(deps, blobs, target.teamId, file.blobRef);
      return { ok: false, error: err.failure };
    }
    // Ambiguous failures keep the object (a committed row may reference it).
    logger.error({ err, teamId: target.teamId }, "project file commit failed");
    return { ok: false, error: "storage_failed" };
  }
}

async function sniffHead(blobs: BlobStore, key: string): Promise<Uint8Array> {
  const object = await blobs.objects.get(key);
  if (!object) throw new Error("project file copy is missing");
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    for await (const chunk of object.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      have += chunk.length;
      if (have >= SNIFF_BYTES) break;
    }
  } finally {
    object.body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
}

export interface IncomingProjectFile {
  readonly folder: string | undefined;
  readonly name: string;
  /** The project's slug, to refuse a path too long once mounted before any byte is stored. */
  readonly slug?: string | undefined;
  readonly declaredMime: string;
  readonly body: Readable;
  /** Set by Add to project (KOBE-585); the file is still `source: "upload"`. */
  readonly importedFrom?: ImportedFrom | undefined;
}

/** A person's upload: stream, hash, copy to the file's key, then the row (see module header). */
export async function uploadProjectFile(
  deps: ProjectFileDeps,
  target: FileTarget,
  incoming: IncomingProjectFile,
): Promise<FileOutcome> {
  const blobs = deps.blobs;
  if (!blobs) return { ok: false, error: "storage_failed" };
  const path = projectFilePath(incoming.folder, incoming.name);
  const refusal =
    path === undefined
      ? "invalid_path"
      : incoming.slug !== undefined && !fitsMount(incoming.slug, path)
        ? "path_too_long"
        : undefined;
  if (path === undefined || refusal !== undefined) {
    incoming.body.destroy();
    return { ok: false, error: refusal ?? "invalid_path" };
  }
  const limit = Math.min(PROJECT_FILE_MAX_BYTES, deps.maxFileBytes);
  const staging = stagingKey(blobs, target.teamId, target.projectId);
  const id = randomUUID();
  const key = projectFileKey(blobs, target.teamId, target.projectId, id);
  const meter = new UploadMeter(limit);
  try {
    await reserve(deps, target, [staging, key]);
    pipeline(incoming.body, meter, () => undefined);
    await blobs.objects.putStream(staging, meter);
  } catch (err) {
    meter.destroy();
    incoming.body.destroy();
    await discardReserved(deps, blobs, target.teamId, staging);
    if (err instanceof UploadTooLargeError || meter.bytes > limit) {
      return { ok: false, error: "file_too_large" };
    }
    logger.error({ err, teamId: target.teamId }, "project file upload failed");
    return { ok: false, error: "storage_failed" };
  }
  try {
    await blobs.objects.copy(staging, key);
  } catch (err) {
    logger.error({ err, teamId: target.teamId }, "project file copy failed");
    await discardReserved(deps, blobs, target.teamId, staging);
    return { ok: false, error: "storage_failed" };
  }
  await discardReserved(deps, blobs, target.teamId, staging);
  let mime: string;
  try {
    mime = resolveMime(await sniffHead(blobs, key), incoming.declaredMime);
  } catch {
    await discardReserved(deps, blobs, target.teamId, key);
    return { ok: false, error: "storage_failed" };
  }
  return commitProjectFile(deps, blobs, target, {
    id,
    path,
    size: meter.bytes,
    sha256: meter.digest(),
    mime,
    blobRef: key,
    source: "upload",
    importedFrom: incoming.importedFrom,
  });
}

/**
 * Removes a file's row (audited, in the caller's transaction) and records the removal as a commit
 * (KOBE-579): the object stays, because the previous commit's tree still names it; history
 * pruning queues it for the blob deleter once no commit does (GV3). Returns the file's object key,
 * or undefined when there is no such file.
 */
export async function removeProjectFile(
  tx: KobeTx,
  actorId: string,
  teamId: string,
  projectId: string,
  fileId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .delete(projectFiles)
    .where(
      and(
        eq(projectFiles.teamId, teamId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.id, fileId),
      ),
    )
    .returning({ blobRef: projectFiles.blobRef, path: projectFiles.path });
  if (!row) return undefined;
  await recordAudit(tx, {
    action: "project.file_removed",
    actor: { kind: "user", id: actorId },
    teamId,
    target: { projectId, fileId },
  });
  await commitFiles(tx, teamId, projectId, { userId: actorId, kind: "user" }, `Remove ${row.path}`);
  return row.blobRef;
}
