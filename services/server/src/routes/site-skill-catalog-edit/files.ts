import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import { hitRateLimit } from "../../rate-limit.js";
import { DRAFT_LIMITS, DRAFT_WRITE_RATE } from "../../skills/drafts/files.js";
import {
  deleteSiteDraftFile,
  draftFile,
  draftOf,
  writeRoom,
  writeSiteDraftFile,
} from "../../skills/site-edit/site-drafts.js";
import { readBounded } from "../skill-drafts.js";
import { error, ifMatch, pathAfter, draftJson, type Ctx, type CatalogEditKit } from "./shared.js";

/** The site draft's files: read, and write or delete under `If-Match`. */
export function catalogDraftFileRoutes(kit: CatalogEditKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { db, failure, skillId } = kit;

  app.get("/:skillId/draft/files/*", async (c) => {
    const id = skillId(c);
    const draft = id ? await draftOf(db, id) : null;
    const path = draft ? pathAfter(c, "/draft/files/") : null;
    const file = draft && path !== null ? await draftFile(db, draft.id, path) : null;
    if (!draft || !file) return error(c, 404, "not_found", "No such file.");
    return new Response(file.bytes, {
      status: 200,
      headers: {
        "content-type":
          file.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
        "content-length": String(file.bytes.length),
        etag: `"${draft.rev}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  });

  const fileChange = async (c: Ctx, mode: "put" | "delete") => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const path = pathAfter(c, "/draft/files/");
    if (path === null) return error(c, 400, "invalid_path", "That file path doesn't decode.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const userId = c.get("user").id;
    if (!(await hitRateLimit(db, `skill-draft-write:${userId}`, DRAFT_WRITE_RATE)))
      return error(c, 429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
    let r;
    if (mode === "delete") r = await deleteSiteDraftFile(db, userId, id, rev, path);
    else {
      const room = await writeRoom(db, id, path);
      if (!room) return error(c, 404, "not_found", "This skill has no site draft.");
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
      r = await writeSiteDraftFile(db, userId, id, rev, path, body);
    }
    if (!r.ok) return failure(c, r);
    c.header("ETag", `"${r.draft.rev}"`);
    return c.json({ rev: r.draft.rev, draft: draftJson(r.draft) });
  };
  app.put("/:skillId/draft/files/*", (c) => fileChange(c, "put"));
  app.delete("/:skillId/draft/files/*", (c) => fileChange(c, "delete"));

  return app;
}
