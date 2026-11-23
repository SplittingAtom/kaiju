import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { isLegalHoldViolation, withTeam } from "@kobe/db";
import {
  importProjectFileRequestSchema,
  PROJECT_FILE_MAX_BYTES,
  projectFileUploadFieldsSchema,
} from "@kobe/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import { loadAccess } from "../../projects/access.js";
import { importProjectFile, type ImportRefusal } from "../../projects/import.js";
import {
  listProjectFiles,
  removeProjectFile,
  uploadProjectFile,
  type ProjectFileFailure,
} from "../../projects/files.js";
import { openUpload } from "../../uploads/parse.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../../uploads/settings.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { OPERATION_LIMITS, admitOperation, rateLimited } from "../../operation-limits.js";
import {
  failure,
  FILE_ERRORS,
  IMPORT_ERRORS,
  MULTIPART_OVERHEAD,
  idParam,
  type ProjectContext,
  type ProjectKit,
} from "./shared.js";

/** Project files (KOBE-162): list, upload, Add to project (KOBE-585), delete. */
export function projectFileRoutes(kit: ProjectKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, sync, viewerOf, withProject } = kit;

  // ------------------------------------------------------------------ files (KOBE-162)

  const fileFailure = (c: ProjectContext, error: ProjectFileFailure) => {
    const [status, code, message] = FILE_ERRORS[error];
    // GV2: a quota refusal names the limit (bytes or objects).
    const limit =
      error === "quota_exceeded" ? "bytes" : error === "object_budget" ? "objects" : undefined;
    return c.json({ code, message, ...(limit === undefined ? {} : { limit }) }, status);
  };

  app.get("/:id/files", (c) =>
    withProject(c, "view", async (tx, access) =>
      c.json({ files: await listProjectFiles(tx, access.project) }),
    ),
  );

  app.post("/:id/files", async (c) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ code: "invalid_input", message: "Send multipart/form-data." }, 415);
    }
    const settings = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    const maxBytes = Math.min(PROJECT_FILE_MAX_BYTES, settings.maxFileBytes);
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isSafeInteger(length) || length < 0) {
      return c.json({ code: "invalid_input", message: "Content-Length is required." }, 411);
    }
    if (length > maxBytes + MULTIPART_OVERHEAD) return fileFailure(c, "file_too_large");
    const body = c.req.raw.body;
    if (!body) return invalidRequest(c, "No file was sent.");
    // The permission is checked before a byte is read (404/403 first, then the stream).
    const viewer = viewerOf(c);
    const id = param(c, "id", idParam);
    if (!id.success) return failure(c, "not_found");
    const access = await withTeam(db, viewer.teamId, (tx) => loadAccess(tx, viewer, id.data));
    if (!access) return failure(c, "not_found");
    if (!access.can.edit) return failure(c, "forbidden");
    // KOBE-813: the member's upload limit, shared with the composer and the Files panel.
    const limit = OPERATION_LIMITS.upload;
    const verdict = await admitOperation(db, limit, viewer.userId);
    if (!verdict.allowed) return rateLimited(c, limit, verdict);
    const opened = await openUpload(
      c.req.header("content-type"),
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      projectFileUploadFieldsSchema,
    );
    if (!opened.ok) return invalidRequest(c, opened.reason);
    const { upload } = opened;
    const result = await uploadProjectFile(
      {
        db,
        blobs: deps.blobs,
        maxFileBytes: settings.maxFileBytes,
        teamQuotaDefaultBytes: settings.defaultQuotaBytes,
        teamMaxObjectsDefault: settings.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      },
      { teamId: viewer.teamId, projectId: access.project.id, userId: viewer.userId },
      {
        folder: upload.fields.path,
        name: upload.name,
        slug: access.project.slug,
        declaredMime: upload.declaredMime,
        body: upload.file,
      },
    );
    if (!result.ok) return fileFailure(c, result.error);
    await deps.projectMounts.reconcileProject(viewer.teamId, access.project.id);
    return c.json(result.file, 201);
  });

  /** Add to project (KOBE-585; `projects/import.ts`): an artifact version or own file, copied. */
  app.post("/:id/files/import", async (c) => {
    const id = param(c, "id", idParam);
    if (!id.success) return failure(c, "not_found");
    const body = await parseBody(c, importProjectFileRequestSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give source (an artifact version or a workspace path), and optionally folder and name.",
      );
    }
    const settings = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    const viewer = viewerOf(c);
    const result = await importProjectFile(
      {
        db,
        blobs: deps.blobs,
        sync,
        maxFileBytes: settings.maxFileBytes,
        teamQuotaDefaultBytes: settings.defaultQuotaBytes,
        teamMaxObjectsDefault: settings.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      },
      viewer,
      id.data,
      body,
    );
    if (!result.ok) {
      if (result.error in IMPORT_ERRORS) {
        const [status, code, message] = IMPORT_ERRORS[result.error as ImportRefusal];
        return c.json({ code, message }, status);
      }
      return fileFailure(c, result.error as ProjectFileFailure);
    }
    await deps.projectMounts.reconcileProject(viewer.teamId, id.data);
    return c.json(result.file, 201);
  });

  app.delete("/:id/files/:file_id", async (c) => {
    const fileId = param(c, "file_id", idParam);
    if (!fileId.success) return failure(c, "not_found");
    let key: string | undefined;
    const res = await withProject(c, "edit", async (tx, access) => {
      // Archive freezes the project's files (P2-41), as it does uploads, commits and reverts.
      if (access.project.archivedAt !== null) return failure(c, "archived");
      try {
        // A savepoint: the hold guard (KH001) refuses the delete without ending the transaction.
        key = await tx.transaction((sp) =>
          removeProjectFile(
            sp,
            viewerOf(c).userId,
            access.project.teamId,
            access.project.id,
            fileId.data,
          ),
        );
      } catch (err) {
        if (isLegalHoldViolation(err)) {
          return c.json(
            { code: "forbidden", message: "The team is under a legal hold: files stay." },
            409,
          );
        }
        throw err;
      }
      return key === undefined ? failure(c, "not_found") : c.body(null, 204);
    });
    // The object stays (the previous commit names it; KOBE-579): only the mounts change.
    if (res.ok && key !== undefined) {
      await deps.projectMounts.reconcileProject(viewerOf(c).teamId, c.req.param("id") ?? "");
    }
    return res;
  });

  return app;
}
