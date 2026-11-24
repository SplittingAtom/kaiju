import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import { logger } from "../../logger.js";
import { hitRateLimit } from "../../rate-limit.js";
import { DRAFT_PREVIEW_RATE } from "../../skills/drafts/files.js";
import { compareWithKaiju, resetToKaiju } from "../../skills/site-edit/kaiju-detach.js";
import { notifyMaintainers } from "../../skills/site-edit/site-notify.js";
import { previewSiteDraft, suggestSiteBump } from "../../skills/site-edit/site-preview.js";
import { publishSiteDraft } from "../../skills/site-edit/site-publish.js";
import { readJson } from "../../http/request.js";
import { error, publishSchema, ifMatch, type Ctx, type CatalogEditKit } from "./shared.js";

/** Scan preview, suggested bump and publish of the site draft; a Kaiju skill's compare and reset. */
export function catalogPublishRoutes(kit: CatalogEditKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { db, blobsOr, unavailable, kaijuDeps, failure, skillId } = kit;

  const previewAllowed = (c: Ctx) =>
    hitRateLimit(db, `skill-draft-preview:${c.get("user").id}`, DRAFT_PREVIEW_RATE);

  app.get("/:skillId/draft/scan", async (c) => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    c.header("cache-control", "private, no-store");
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many scans. Wait a few minutes and try again.");
    const r = await previewSiteDraft(db, id, c.get("user").id, c.req.raw.signal);
    if (r.ok) {
      const { verdict, findings, scripts, skipped, ruleSetVersion } = r.scan;
      return c.json({ rev: r.rev, verdict, findings, scripts, skipped, ruleSetVersion });
    }
    switch (r.error) {
      case "not_found":
        return error(c, 404, "not_found", "This skill has no site draft.");
      case "busy":
        c.header("Retry-After", "1");
        return error(c, 429, "scan_busy", "The scan preview is busy. It runs again shortly.");
      case "unavailable":
        c.header("Retry-After", "5");
        return error(c, 503, "scan_unavailable", "The scan preview couldn't finish just now.");
      case "package_problem":
        return error(c, 422, "invalid_package", r.message);
    }
  });

  app.get("/:skillId/draft/bump", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many requests. Wait a few minutes and try again.");
    const bump = id ? await suggestSiteBump(db, blobs, id) : null;
    if (!bump) return error(c, 404, "not_found", "This skill has no site draft.");
    return c.json(bump);
  });

  app.post("/:skillId/draft/publish", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const body = publishSchema.safeParse(await readJson(c, undefined));
    if (!body.success)
      return error(c, 400, "invalid_request", "Give a semver (1.2.3) and a changelog.");
    const userId = c.get("user").id;
    const r = await publishSiteDraft({ db, blobs }, userId, id, { ...body.data, rev });
    if (!r.ok) return failure(c, r);
    const notified = await notifyMaintainers(db, r.published, userId).catch((err: unknown) => {
      logger.error({ err, skillId: id }, "skills: maintainers not told of a site version");
      return 0;
    });
    const { notifyTeamId: _team, ...published } = r.published;
    return c.json({ version: published, notified }, 201);
  });

  app.get("/:skillId/kobe/compare", async (c) => {
    const id = skillId(c);
    const k = kaijuDeps();
    if (!k) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    const r = await compareWithKaiju(k, id);
    if (r.ok) return c.json(r.compare);
    switch (r.code) {
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill.");
      case "not_kobe":
        return error(c, 409, "not_kobe", "Only Kaiju's own skills compare with a shipped version.");
      case "not_shipped":
        return error(c, 409, "not_shipped", "This release of Kaiju doesn't ship that skill.");
      case "not_stored":
        return error(c, 409, "not_stored", "The current version's files are not in the store.");
    }
  });

  app.post("/:skillId/kobe/reset", async (c) => {
    const id = skillId(c);
    const k = kaijuDeps();
    if (!k) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    const r = await resetToKaiju(k, id, c.get("user").id);
    if (r.ok) return c.json({ shippedSemver: r.shippedSemver, seed: r.seed });
    switch (r.code) {
      case "forbidden":
        return error(c, 403, "forbidden", "You don't have permission to do that.");
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill.");
      case "not_kobe":
        return error(c, 409, "not_kobe", "Only Kaiju's own skills reset to Kaiju.");
      case "not_detached":
        return error(c, 409, "not_detached", "This skill already follows Kaiju's shipped version.");
      case "not_shipped":
        return error(c, 409, "not_shipped", "This release of Kaiju doesn't ship that skill.");
      case "shipped_not_above":
        return error(
          c,
          409,
          "shipped_not_above",
          `Kaiju ships ${r.shippedSemver}, which is not above the Site's ${r.siteSemver}: the skill stays detached until Kaiju ships a higher version.`,
          { shippedSemver: r.shippedSemver, siteSemver: r.siteSemver },
        );
    }
  });

  return app;
}
