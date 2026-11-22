import { Hono } from "hono";
import type { TeamVariables } from "../../authz/middleware.js";
import { hitRateLimit } from "../../rate-limit.js";
import { param } from "../../http/request.js";
import { SKILL_UPLOAD_RATE } from "../../skills/limits.js";
import { DRAFT_PREVIEW_RATE } from "../../skills/drafts/files.js";
import { previewDraftScan } from "../../skills/drafts/scan-preview.js";
import { suggestDraftBump } from "../../skills/drafts/suggest.js";
import { saveDraftVersion } from "../../skills/drafts/save.js";
import { skillJson, versionJson } from "../skill-json.js";
import {
  destinationSchema,
  error,
  idSchema,
  ifMatch,
  saveSchema,
  type Ctx,
  type DraftKit,
} from "./shared.js";

/** Before shipping a draft: the scan preview (SK12), the suggested bump (SK14), Save version. */
export function draftSaveRoutes(kit: DraftKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, skillStore, ctxOf, json } = kit;

  const previewAllowed = (c: Ctx) =>
    hitRateLimit(db, `skill-draft-preview:${c.get("user").id}`, DRAFT_PREVIEW_RATE);

  // The live scan preview (SK12): the verdict tier and findings of the draft as stored now. Only
  // a request that needs a new scan counts against the rate (review S3).
  app.get("/:id/scan", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const result = await previewDraftScan(ctxOf(c), id.data, {
      admit: () => previewAllowed(c),
      signal: c.req.raw.signal,
    });
    c.header("cache-control", "private, no-store");
    if (result.ok) {
      c.header("ETag", `"${result.rev}"`);
      const { verdict, findings, scripts, skipped, ruleSetVersion } = result.scan;
      return c.json({ rev: result.rev, verdict, findings, scripts, skipped, ruleSetVersion });
    }
    switch (result.error) {
      case "not_found":
        return error(c, 404, "not_found", "No such draft.");
      case "rate_limited":
        return error(c, 429, "rate_limited", "Too many scans. Wait a few minutes and try again.");
      case "busy":
        // Scans are busy or a newer request took this one's place: ask again in a second.
        c.header("Retry-After", "1");
        return error(c, 429, "scan_busy", "The scan preview is busy. It runs again shortly.");
      case "unavailable":
        c.header("Retry-After", "5");
        return error(
          c,
          503,
          "scan_unavailable",
          "The scan preview couldn't finish just now. It tries again; saving scans the draft in full.",
        );
      case "package_problem":
        return error(c, 422, "invalid_package", result.message);
    }
  });

  // The bump Save version suggests (SK14) against the destination's latest version.
  app.get("/:id/bump", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const destination = destinationSchema.safeParse(c.req.query("destination"));
    if (!destination.success)
      return error(c, 400, "invalid_request", "Give destination=team or destination=personal.");
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many requests. Wait a few minutes and try again.");
    const result = await suggestDraftBump(ctxOf(c), store, id.data, destination.data);
    if (!result.ok)
      return result.error === "not_found"
        ? error(c, 404, "not_found", "No such draft.")
        : error(c, 503, "skills_unavailable", "The latest version can't be read right now.");
    const { rev, latest, kind, suggested, reasons } = result;
    return c.json({ rev, latest, kind, suggested, reasons });
  });

  app.post("/:id/versions", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const body = saveSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give destination (team or personal), semver (MAJOR.MINOR.PATCH) and a changelog line.",
      );
    // Saves carry the revision the author saw (SK11): nobody ships a co-editor's unseen change.
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many uploads. Wait a few minutes and try again.");
    const result = await saveDraftVersion(
      { ...ctxOf(c), teamName: c.get("team").name },
      store,
      id.data,
      {
        destination: body.data.destination,
        semver: body.data.semver,
        changelog: body.data.changelog,
        confirmPersonal: body.data.confirmPersonal ?? false,
        rev,
      },
    );
    if (!result.ok) {
      if ("retryAfter" in result && result.retryAfter !== undefined)
        c.header("Retry-After", String(result.retryAfter));
      return error(
        c,
        result.status,
        result.code,
        result.message,
        "extra" in result ? result.extra : {},
      );
    }
    const review =
      body.data.destination === "team"
        ? { status: "pending", flagged: result.scan.findings.length > 0 }
        : null;
    return c.json(
      { skill: skillJson(result.skill), version: versionJson(result.version, review) },
      201,
    );
  });

  return app;
}
