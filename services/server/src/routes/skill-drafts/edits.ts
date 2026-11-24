import { withTeam } from "@kaiju/db";
import { Hono } from "hono";
import type { TeamVariables } from "../../authz/middleware.js";
import { hitRateLimit } from "../../rate-limit.js";
import { logger } from "../../logger.js";
import { param } from "../../http/request.js";
import { DRAFT_LIMITS, DRAFT_WRITE_RATE } from "../../skills/drafts/files.js";
import { listVisibleDrafts, readFile, visibleDraft } from "../../skills/drafts/records.js";
import {
  deleteDraftFile,
  readDraft,
  removeDraft,
  setDraftShared,
  writeDraftFile,
  writeRoom,
} from "../../skills/drafts/service.js";
import { deleteDraftBundles } from "../../skills/drafts/test-holds.js";
import {
  decodeCursor,
  draftJson,
  encodeCursor,
  error,
  fileJson,
  filePath,
  idSchema,
  ifMatch,
  patchSchema,
  readBounded,
  type Ctx,
  type DraftKit,
} from "./shared.js";

/**
 * Reading and editing drafts (KOBE-320): the list, one draft, its `shared` flag, deleting it,
 * and its files (read, write and delete under `If-Match`).
 */
export function draftEditRoutes(kit: DraftKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, ctxOf, failure, json } = kit;

  app.get("/", async (c) => {
    const ctx = ctxOf(c);
    const raw = c.req.query("cursor");
    const cursor = raw === undefined ? null : decodeCursor(raw);
    if (cursor === undefined) return error(c, 400, "invalid_request", "That cursor is not valid.");
    const page = await withTeam(db, ctx.teamId, (tx) =>
      listVisibleDrafts(tx, ctx.teamId, ctx.viewer, cursor),
    );
    return c.json({
      drafts: page.drafts.map((d) => draftJson(d, ctx.viewer.userId)),
      next: page.next ? encodeCursor(page.next) : null,
    });
  });

  app.get("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    const found = id.success ? await readDraft(ctxOf(c), id.data) : null;
    if (!found) return error(c, 404, "not_found", "No such draft.");
    c.header("ETag", `"${found.draft.rev}"`);
    return c.json({
      draft: draftJson(found.draft, c.get("user").id),
      files: found.files.map(fileJson),
    });
  });

  app.patch("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const body = patchSchema.safeParse(await json(c));
    if (!body.success) return error(c, 400, "invalid_request", "Give shared: true or false.");
    const result = await setDraftShared(ctxOf(c), id.data, rev, body.data.shared);
    if (!result.ok) return failure(c, result);
    return c.json({ draft: draftJson(result.draft, c.get("user").id) });
  });

  app.delete("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const ctx = ctxOf(c);
    const result = await removeDraft(ctx, id.data);
    if (!result.ok) return failure(c, result);
    // Its test bundles (KOBE-323) go too; the retention pass sweeps any a failure here left.
    if (deps.blobs)
      await deleteDraftBundles(db, deps.blobs, ctx.teamId, id.data).catch((err: unknown) =>
        logger.warn({ err, draftId: id.data }, "skill drafts: test bundles not deleted yet"),
      );
    return c.body(null, 204);
  });

  app.get("/:id/files/*", async (c) => {
    const id = param(c, "id", idSchema);
    const path = id.success ? filePath(c, id.data) : null;
    if (!id.success || path === null) return error(c, 404, "not_found", "No such file.");
    const ctx = ctxOf(c);
    const found = await withTeam(db, ctx.teamId, async (tx) => {
      const draft = await visibleDraft(tx, ctx.teamId, id.data, ctx.viewer);
      const file = draft ? await readFile(tx, ctx.teamId, id.data, path) : null;
      return draft && file ? { draft, file } : null;
    });
    if (!found) return error(c, 404, "not_found", "No such file.");
    return new Response(found.file.bytes, {
      status: 200,
      headers: {
        "content-type":
          found.file.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
        "content-length": String(found.file.bytes.length),
        etag: `"${found.draft.rev}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  });

  /**
   * A file write or delete. Everything that can refuse it (path, If-Match, the rate, whether the
   * caller may edit the draft, the room left) is checked before a byte of the body is read, and the
   * body is read only up to that room (review S3); the write checks again under the draft's lock.
   */
  const fileChange = async (c: Ctx, mode: "put" | "delete") => {
    const id = param(c, "id", idSchema);
    const path = id.success ? filePath(c, id.data) : null;
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    if (path === null) return error(c, 400, "invalid_path", "That file path doesn't decode.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    if (!(await hitRateLimit(db, `skill-draft-write:${c.get("user").id}`, DRAFT_WRITE_RATE)))
      return error(c, 429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
    const ctx = ctxOf(c);
    if (mode === "delete") return changed(c, await deleteDraftFile(ctx, id.data, rev, path));
    const room = await writeRoom(ctx, id.data, path);
    if (!room.ok) return failure(c, room);
    const body = await readBounded(c.req.raw, Math.max(room.room, 0));
    if (body === null)
      return room.skillMd
        ? error(
            c,
            413,
            "file_too_large",
            `SKILL.md may be at most ${DRAFT_LIMITS.maxSkillMdBytes} bytes.`,
          )
        : error(
            c,
            413,
            "draft_too_large",
            `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
          );
    return changed(c, await writeDraftFile(ctx, id.data, rev, path, body));
  };

  const changed = (
    c: Ctx,
    result: Awaited<ReturnType<typeof writeDraftFile>>,
  ): Response | Promise<Response> => {
    if (!result.ok) return failure(c, result);
    c.header("ETag", `"${result.draft.rev}"`);
    return c.json({ rev: result.draft.rev, draft: draftJson(result.draft, c.get("user").id) });
  };

  app.put("/:id/files/*", (c) => fileChange(c, "put"));
  app.delete("/:id/files/*", (c) => fileChange(c, "delete"));

  return app;
}
