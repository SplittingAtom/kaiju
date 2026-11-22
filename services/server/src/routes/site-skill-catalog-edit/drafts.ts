import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import {
  siteSkillView,
  siteVersionFile,
  siteVersionView,
} from "../../skills/site-edit/catalog-view.js";
import {
  discardSiteDraft,
  draftFiles,
  draftOf,
  startSiteDraft,
} from "../../skills/site-edit/site-drafts.js";
import { param, readJson } from "../../http/request.js";
import {
  error,
  idSchema,
  startSchema,
  pathAfter,
  draftJson,
  type CatalogEditKit,
} from "./shared.js";

/** The skill and its versions (and their files); starting, reading and dropping the site draft. */
export function catalogSkillDraftRoutes(kit: CatalogEditKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { db, blobsOr, unavailable, failure, skillId } = kit;

  app.get("/:skillId", async (c) => {
    const id = skillId(c);
    const view = id ? await siteSkillView(db, id) : null;
    if (!view) return error(c, 404, "not_found", "No such catalog skill.");
    return c.json(view);
  });

  app.get("/:skillId/versions/:versionId", async (c) => {
    const id = skillId(c);
    const version = param(c, "versionId", idSchema);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id || !version.success) return error(c, 404, "not_found", "No such version.");
    const view = await siteVersionView(db, blobs, id, version.data);
    if (!view) return error(c, 404, "not_found", "No such version.");
    return c.json(view);
  });

  app.get("/:skillId/versions/:versionId/files/*", async (c) => {
    const id = skillId(c);
    const version = param(c, "versionId", idSchema);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id || !version.success) return error(c, 404, "not_found", "No such file.");
    const path = pathAfter(c, `/versions/${version.data}/files/`);
    const file = path ? await siteVersionFile(db, blobs, id, version.data, path) : null;
    if (!file) return error(c, 404, "not_found", "No such file.");
    c.header("cache-control", "private, no-store");
    return c.json(file);
  });

  app.post("/:skillId/draft", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    const body = startSchema.safeParse(await readJson(c, undefined));
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    if (!body.success) return error(c, 400, "invalid_request", "Give the version to start from.");
    const r = await startSiteDraft(
      { db, blobs },
      c.get("user").id,
      id,
      body.data.versionId,
      body.data.replace === true,
    );
    if (!r.ok) return failure(c, r);
    c.header("ETag", `"${r.draft.rev}"`);
    return c.json({ draft: draftJson(r.draft), files: await draftFiles(db, r.draft.id) }, 201);
  });

  app.get("/:skillId/draft", async (c) => {
    const id = skillId(c);
    const draft = id ? await draftOf(db, id) : null;
    if (!draft) return error(c, 404, "not_found", "This skill has no site draft.");
    c.header("ETag", `"${draft.rev}"`);
    return c.json({ draft: draftJson(draft), files: await draftFiles(db, draft.id) });
  });

  app.delete("/:skillId/draft", async (c) => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const r = await discardSiteDraft(db, c.get("user").id, id);
    return r.ok ? c.body(null, 204) : failure(c, r);
  });

  return app;
}
