import { randomUUID } from "node:crypto";
import {
  isLegalHoldViolation,
  isUnderLegalHold,
  lockLegalHolds,
  withTeam,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import {
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILES_MAX,
  promotedFolderMessage,
  type PromoteFolderRequest,
} from "@kaiju/protocol";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { deleteWorkspaceFiles } from "../workspace-files/delete.js";
import { areaOf, isInternalPath } from "../workspace-files/paths.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry, listLive, lockWorkspace } from "../workspace-sync/store.js";
import type { ProjectRow } from "./access.js";
import { sourceCheck } from "./commits.js";
import { copyFrom, copyThenWrite, sumSizes, type Copy } from "./copy-loop.js";
import type { ProjectMounts } from "./mounts.js";
import { fitsMount, isConflictCopy } from "./paths.js";
import { createProject } from "./repository.js";
import { deriveSlug } from "./slug.js";
import { checkLimitsAfterWrite, OverLimit, type TeamLimits } from "./storage.js";
import { projectBlobKey, writeCommit, type TreeFile } from "./tree.js";

/**
 * Promote a My files folder to a project (KOBE-586, projects-in-conversations PF3-PF4). Like a
 * commit (`commits.ts`), in three steps so no transaction is held while bytes move:
 *  1. plan (read): the folder in the caller's own manifest (never `uploads/`, `projects/` or an
 *     internal path; never another member's), every limit (file count, file size, path rules,
 *     conflict copies), the legal hold, and the contents to copy;
 *  2. copy (no transaction): each content from the member's object to the new project's
 *     `blobs/<sha256>`, hash and size verified, its key reserved first in
 *     `retention_blob_deletions` (due in hours), so a failure leaves nothing the deleter won't take;
 *  3. write (legal-hold lock, the member's workspace lock, the team storage lock): plan again (the
 *     same files, else back to 2), the quota, then the project (caller = owner,
 *     `project.created`), its one commit (`project.committed`) and, only once both exist, the
 *     folder's Delete as the Files panel does it (tombstones the sandbox pulls,
 *     `workspace.file_deleted`). One transaction: any failure leaves My files and the projects
 *     as they were.
 * The caller then mounts the project for the member (PF3, MT1 creator rule in `mounts.ts`).
 */

export interface PromoteDeps {
  readonly db: KaijuDb;
  readonly blobs: BlobStore | undefined;
  readonly sync: WorkspaceSync | undefined;
  readonly mounts: Pick<ProjectMounts, "reconcileUser">;
  readonly limits: TeamLimits & { readonly maxFileBytes: number };
  readonly log: Pick<Logger, "warn">;
}

export type PromoteRefusal =
  | "not_found"
  | "outside_my_files"
  | "not_a_folder"
  | "empty_folder"
  | "too_many_files"
  | "file_too_large"
  | "invalid_path"
  | "conflict_file"
  | "quota_exceeded"
  | "legal_hold"
  | "slug_taken"
  | "changed"
  | "storage_failed";

export type PromoteResult =
  | { readonly status: "created"; readonly project: ProjectRow }
  | {
      readonly status: "refused";
      readonly error: PromoteRefusal;
      /** The file (relative to the folder) a path or size refusal names. */
      readonly path?: string;
      readonly limit?: "bytes" | "objects";
    };

interface Plan {
  /** Path in the project -> the file, `mime` filled after the copy. */
  readonly files: ReadonlyMap<string, Omit<TreeFile, "mime">>;
  readonly copies: readonly Copy[];
  /** The folder's live rows (deleted from My files once the commit exists). */
  readonly live: readonly { readonly path: string; readonly size: number }[];
  /** What the plan saw, to tell a changed folder in step 3. */
  readonly fingerprint: string;
}

const refused = (
  error: PromoteRefusal,
  extra: { path?: string; limit?: "bytes" | "objects" } = {},
): PromoteResult => ({ status: "refused", error, ...extra });

/** A path too long under the slug the project got (KOBE-780); rolls the project back. */
class PathTooLong extends Error {
  constructor(readonly path: string) {
    super("path too long once mounted");
  }
}

/**
 * Step 1 (and again in step 3). `slug` is the one the name derives (KOBE-780: every path must fit
 * once mounted under it); the write step checks again under the slug the project really gets.
 */
async function plan(
  tx: KaijuTx,
  deps: Pick<PromoteDeps, "limits"> & { readonly prefix: string },
  owner: WorkspaceOwner,
  folder: string,
  projectId: string,
  slug: string,
): Promise<Plan | PromoteResult> {
  if (isInternalPath(folder)) return refused("not_found");
  if (areaOf(folder) !== "workspace") return refused("outside_my_files");
  const exact = await currentEntry(tx, owner, folder);
  if (exact && !exact.deleted) return refused("not_a_folder");
  const live = await listLive(tx, owner, `${folder}/`, PROJECT_FILES_MAX + 1);
  if (live.length === 0) return refused("empty_folder");
  if (live.length > PROJECT_FILES_MAX) return refused("too_many_files");
  if (await isUnderLegalHold(tx, owner.teamId, owner.userId)) return refused("legal_hold");
  const maxBytes = Math.min(PROJECT_FILE_MAX_BYTES, deps.limits.maxFileBytes);
  for (const e of live) {
    const rel = e.path.slice(folder.length + 1);
    if (!fitsMount(slug, rel) || isInternalPath(rel)) {
      return refused("invalid_path", { path: rel });
    }
    if (e.size > maxBytes) return refused("file_too_large", { path: rel });
    if (isConflictCopy(rel)) return refused("conflict_file", { path: rel });
  }
  const allowed = await sourceCheck(
    tx,
    deps.prefix,
    owner,
    live.map((e) => e.blobKey ?? ""),
  );
  const files = new Map<string, Omit<TreeFile, "mime">>();
  const copies = new Map<string, Copy>();
  for (const e of live) {
    const rel = e.path.slice(folder.length + 1);
    if (e.sha256 === undefined || e.blobKey === null || !allowed(e.blobKey)) {
      return refused("storage_failed", { path: rel });
    }
    const key = projectBlobKey(deps.prefix, owner.teamId, projectId, e.sha256);
    if (!copies.has(e.sha256)) {
      copies.set(e.sha256, { sha256: e.sha256, size: e.size, source: e.blobKey, key });
    }
    files.set(rel, {
      path: rel,
      sha256: e.sha256,
      size: e.size,
      executable: e.executable,
      blobRef: key,
    });
  }
  return {
    files,
    copies: [...copies.values()],
    live: live.map((e) => ({ path: e.path, size: e.size })),
    fingerprint: live.map((e) => `${e.path}\0${e.sha256}\0${e.size}\0${e.executable}`).join("\n"),
  };
}

export async function promoteFolder(
  deps: PromoteDeps,
  owner: WorkspaceOwner,
  request: PromoteFolderRequest,
): Promise<PromoteResult> {
  const { sync, blobs } = deps;
  if (!sync || !blobs) return refused("storage_failed");
  const projectId = randomUUID();
  const planDeps = { limits: deps.limits, prefix: blobs.prefix };
  const slug = deriveSlug(request.name);
  // The first plan, to tell a folder that changed between plan and write (its fingerprint).
  let planned: Plan | undefined;
  const written = await copyThenWrite<Plan, PromoteResult>({
    db: deps.db,
    teamId: owner.teamId,
    projectId,
    userId: owner.userId,
    limits: deps.limits,
    log: deps.log,
    failure: "promote to project: a copy failed",
    plan: async () => {
      const p = await withTeam(deps.db, owner.teamId, (tx) =>
        plan(tx, planDeps, owner, request.path, projectId, slug),
      );
      if (!("status" in p)) planned = p;
      return p;
    },
    isPlan: (p): p is Plan => !("status" in p),
    copiesOf: (p) => p.copies,
    store: copyFrom(blobs.objects),
    write: (mimes) =>
      planned === undefined
        ? Promise.resolve("again" as const)
        : writeStep(deps, sync, owner, request, projectId, planned, mimes),
    refuse: {
      quota: (limit) => refused("quota_exceeded", { limit }),
      storage: () => refused("storage_failed"),
      changed: () => refused("changed"),
    },
  });
  if (written.status === "created") {
    // PF3: the creator sees the project under Projects at once (failures only log; the next
    // run start reconciles again).
    await deps.mounts.reconcileUser(owner.teamId, owner.userId);
  }
  return written;
}

async function writeStep(
  deps: PromoteDeps,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  request: PromoteFolderRequest,
  projectId: string,
  planned: Plan,
  mimes: ReadonlyMap<string, string>,
): Promise<PromoteResult | "again"> {
  const prefix = deps.blobs?.prefix ?? "";
  return withTeam(deps.db, owner.teamId, async (tx) => {
    // The Delete's own locks (legal hold, then the workspace), then the plan again.
    await lockLegalHolds(tx);
    await lockWorkspace(tx, owner);
    const again = await plan(
      tx,
      { limits: deps.limits, prefix },
      owner,
      request.path,
      projectId,
      deriveSlug(request.name),
    );
    if ("status" in again) return again;
    if (again.fingerprint !== planned.fingerprint) return "again";
    if (again.copies.some((c) => !mimes.has(c.sha256))) return "again";
    const tree = new Map<string, TreeFile>();
    for (const [path, f] of again.files) {
      tree.set(path, { ...f, mime: mimes.get(f.sha256) ?? "application/octet-stream" });
    }
    try {
      return await tx.transaction(async (sp): Promise<PromoteResult> => {
        const created = await createProject(sp, owner, { name: request.name }, { id: projectId });
        if (!created.ok) return refused("slug_taken");
        // A taken slug gets a suffix (`-2` ...): every path must fit under the slug it got.
        const slug = created.value.row.slug;
        const tooLong = [...tree.keys()].find((path) => !fitsMount(slug, path));
        if (tooLong !== undefined) throw new PathTooLong(tooLong);
        await writeCommit(sp, {
          teamId: owner.teamId,
          projectId,
          tree,
          author: { userId: owner.userId, kind: "user" },
          message: promotedFolderMessage(request.path),
        });
        // The team quota under its lock, after the history aggregate (P2-44).
        await checkLimitsAfterWrite(sp, owner.teamId, deps.limits, {
          bytes: sumSizes(again.copies),
          objects: again.copies.length,
        });
        // Only now that the project and its commit exist does the folder leave My files.
        await deleteWorkspaceFiles(sp, sync, owner, again.live);
        return { status: "created", project: created.value.row };
      });
    } catch (err) {
      if (isLegalHoldViolation(err)) return refused("legal_hold");
      if (err instanceof PathTooLong) return refused("invalid_path", { path: err.path });
      if (err instanceof OverLimit) return refused("quota_exceeded", { limit: err.limit });
      throw err;
    }
  });
}
