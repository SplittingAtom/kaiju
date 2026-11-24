import type { Context } from "hono";
import { type MemoryDocDetail, type MemoryDocSummary, type MemoryScope } from "@kaiju/protocol";
import { withTeam, type KaijuTx } from "@kaiju/db";
import { type TeamVariables } from "../../authz/middleware.js";
import type { ServerDeps } from "../../deps.js";
import { logger } from "../../logger.js";
import { projectMemoryAccess } from "../../memory/access.js";
import { scopeEnabled } from "../../memory/switches.js";
import {
  MemoryStorageError,
  RESTORE_MARK,
  findDoc,
  listVersions,
  readCurrent,
  type DocRow,
  type DocVersion,
  type ListedDoc,
  type MemoryActor,
  type MemoryTarget,
} from "../../memory/store.js";
import type { BlobStore } from "../../retention/blobs.js";
import { uuidSchema } from "../../threads/schemas.js";

export type Ctx = Context<{ Variables: TeamVariables }>;

export const NOT_FOUND = { code: "memory_not_found", message: "No such memory file." } as const;
export const DISABLED = {
  code: "memory_disabled",
  message: "Memory is turned off for this scope.",
} as const;
/** PR6: a reader of the project reads its memory but does not change it. */
export const READ_ONLY = {
  code: "read_only",
  message: "You can read this project's memory but not change it: that needs editor or owner.",
} as const;
export const STORAGE = {
  code: "storage_unavailable",
  message: "Memory storage is unavailable.",
} as const;

/** A step's outcome inside the team transaction: a body or an error response to send. */
export type Out<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 409 | 413 | 422;
      readonly body: object;
    };
export const fail = (status: 400 | 403 | 404 | 409 | 413 | 422, body: object) =>
  ({ ok: false, status, body }) as const;

export const summary = (d: ListedDoc): MemoryDocSummary => ({
  id: d.id,
  scope: d.scope,
  path: d.path,
  current_version: d.currentVersion,
  size_bytes: d.sizeBytes,
  updated_at: d.updatedAt.toISOString(),
  updated_by: d.updatedBy,
});

export const sourceOf = (v: DocVersion) =>
  v.toolCallId?.startsWith(RESTORE_MARK)
    ? ("restore" as const)
    : v.actorKind === "agent"
      ? ("agent" as const)
      : ("panel" as const);

export type MemoryKit = ReturnType<typeof memoryKit>;

/** What the memory panel's route groups share: the storage-guarded transaction and the lookups. */
export function memoryKit(deps: ServerDeps) {
  const db = deps.database.db;

  const run = async <T>(c: Ctx, fn: (tx: KaijuTx, blobs: BlobStore) => Promise<Out<T>>) => {
    const blobs = deps.blobs;
    if (!blobs) return c.json(STORAGE, 503);
    try {
      const out = await withTeam(db, c.get("team").id, (tx) => fn(tx, blobs));
      return out.ok ? c.json(out.value as object) : c.json(out.body, out.status);
    } catch (err) {
      if (!(err instanceof MemoryStorageError)) throw err;
      logger.error({ err, teamId: c.get("team").id }, "memory storage failed");
      return c.json(STORAGE, 503);
    }
  };

  /** Who the target belongs to, after the access and switch checks. */
  const resolveTarget = async (
    tx: KaijuTx,
    c: Ctx,
    scope: MemoryScope,
    projectId: string | undefined,
    write = false,
  ): Promise<Out<MemoryTarget>> => {
    const userId = c.get("user").id;
    let target: MemoryTarget;
    if (scope === "user") {
      if (projectId !== undefined)
        return fail(400, { code: "invalid_request", message: "project_id is for scope=project." });
      target = { scope, ownerUserId: userId };
    } else {
      if (projectId === undefined || !uuidSchema.safeParse(projectId).success) {
        return fail(400, { code: "invalid_request", message: "scope=project needs project_id." });
      }
      const access = await projectMemoryAccess(tx, c.get("team").id, userId, projectId);
      if (access === "none") return fail(404, NOT_FOUND);
      if (write && access !== "write") return fail(403, READ_ONLY);
      target = { scope, projectId };
    }
    if (!(await scopeEnabled(tx, c.get("team").id, scope))) return fail(403, DISABLED);
    return { ok: true, value: target };
  };

  /** The doc if the caller may use it (own personal doc, project member) and its scope is on. */
  const resolveDoc = async (
    tx: KaijuTx,
    c: Ctx,
    id: string,
    write = false,
  ): Promise<Out<DocRow>> => {
    const doc = await findDoc(tx, c.get("team").id, id);
    const userId = c.get("user").id;
    const access =
      doc === undefined
        ? "none"
        : doc.scope === "user"
          ? doc.ownerUserId === userId
            ? "write"
            : "none"
          : doc.projectId === null
            ? "none"
            : await projectMemoryAccess(tx, c.get("team").id, userId, doc.projectId);
    if (!doc || access === "none") return fail(404, NOT_FOUND);
    if (write && access !== "write") return fail(403, READ_ONLY);
    if (!(await scopeEnabled(tx, c.get("team").id, doc.scope))) return fail(403, DISABLED);
    return { ok: true, value: doc };
  };

  const detail = async (tx: KaijuTx, blobs: BlobStore, teamId: string, id: string) => {
    const doc = await findDoc(tx, teamId, id);
    const versions = await listVersions(tx, teamId, id);
    const current = versions.find((v) => v.version === doc?.currentVersion);
    const content = doc ? await readCurrent(tx, blobs, teamId, doc) : null;
    if (!doc || !current || content === null)
      throw new MemoryStorageError("memory content missing");
    const body: MemoryDocDetail = {
      id: doc.id,
      scope: doc.scope,
      path: doc.path,
      current_version: doc.currentVersion,
      size_bytes: current.sizeBytes,
      updated_at: doc.updatedAt.toISOString(),
      updated_by: current.actorUserId,
      content,
      versions: versions.map((v) => ({
        version: v.version,
        size_bytes: v.sizeBytes,
        created_at: v.createdAt.toISOString(),
        source: sourceOf(v),
      })),
    };
    return body;
  };

  const panelActor = (c: Ctx): MemoryActor => ({ kind: "user", userId: c.get("user").id });

  return { deps, db, run, resolveTarget, resolveDoc, detail, panelActor };
}
