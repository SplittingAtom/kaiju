import { skillImportRequestSchema } from "@kobe/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { TeamVariables } from "../../authz/middleware.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import { hitRateLimit } from "../../rate-limit.js";
import { SKILL_LIMITS, SKILL_UPLOAD_RATE } from "../../skills/limits.js";
import { importSkill, type ImportDeps } from "../../skills/import/service.js";
import { startFromUpload, type StartResult } from "../../skills/drafts/starts.js";
import { templates } from "../../skills/drafts/templates.js";
import { recordedSaves } from "../../skills/drafts/saves.js";
import { NO_DRAFTS, error, idSchema, type DraftKit } from "./shared.js";

/** Governed import and uploads (KOBE-344, KOBE-322), the recorded saves and the template list. */
export function draftImportRoutes(
  kit: DraftKit,
  imports: ImportDeps | undefined,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, ctxOf, json, mayStart, started } = kit;

  // Governed import (KOBE-344, SK30): Builders, from the Site's import allowlist only, a git
  // commit or a pinned zip, fetched once through the egress proxy into a new private draft.
  app.post("/import", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.skills.publish"))
      return error(c, 403, "forbidden", "Only Builders and Team admins can import skills.");
    const body = skillImportRequestSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give an https git URL with a full commit SHA (and an optional folder), or an https zip URL with its SHA-256.",
      );
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many imports. Wait a few minutes and try again.");
    const result = await importSkill(
      ctxOf(c),
      {
        http: imports?.http ?? null,
        ...(imports?.deadlineMs ? { deadlineMs: imports.deadlineMs } : {}),
      },
      body.data,
    );
    if (result.ok) return started(c, result as StartResult);
    if (result.error === "not_allowlisted")
      return error(
        c,
        403,
        "import_not_allowed",
        "That host (or owner) is not on this site's import allowlist. A Site admin can add it.",
      );
    if (result.error === "unavailable")
      return error(
        c,
        503,
        "import_unavailable",
        "Imports need the egress proxy (install with the Helm chart).",
      );
    if (result.error === "import_failed")
      return error(c, result.code === "too_large" ? 413 : 422, result.code, result.message);
    return started(c, result as StartResult);
  });

  // The conversation's save_skill_draft saves, as the server recorded them (KOBE-442 review L4).
  app.get("/saves", async (c) => {
    const threadId = idSchema.safeParse(c.req.query("threadId"));
    if (!threadId.success) return error(c, 400, "invalid_request", "Give threadId.");
    const saves = await recordedSaves(ctxOf(c), threadId.data);
    if (!saves) return error(c, 404, "not_found", "No such conversation.");
    return c.json({ saves });
  });

  app.get("/templates", (c) =>
    c.json({
      templates: templates().map(({ id, title, summary }) => ({ id, title, summary })),
    }),
  );

  // An uploaded zip or SKILL.md (KOBE-322): the upload's validation, then the draft's limits.
  app.post(
    "/upload",
    bodyLimit({
      maxSize: SKILL_LIMITS.maxBundleBytes,
      onError: (c) =>
        c.json({ code: "bundle_too_large", message: "That skill is too large." }, 413),
    }),
    async (c) => {
      if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
      const kind = z.enum(["zip", "skill_md"]).safeParse(c.req.query("kind"));
      if (!kind.success) return error(c, 400, "invalid_request", "Give kind=zip or kind=skill_md.");
      if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
        return error(c, 429, "rate_limited", "Too many uploads. Wait a few minutes and try again.");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return started(c, await startFromUpload(ctxOf(c), bytes, kind.data));
    },
  );

  return app;
}
