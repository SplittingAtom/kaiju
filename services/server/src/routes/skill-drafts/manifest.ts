import { MANIFEST_PATH } from "@kaiju/protocol";
import { withTeam } from "@kaiju/db";
import { Hono } from "hono";
import type { TeamVariables } from "../../authz/middleware.js";
import { hitRateLimit } from "../../rate-limit.js";
import { recordAudit } from "../../audit/record.js";
import { param } from "../../http/request.js";
import { readAllFiles, visibleDraft } from "../../skills/drafts/records.js";
import { writeDraftFile } from "../../skills/drafts/service.js";
import { MANIFEST_RATE } from "../skill-promotions.js";
import {
  PLACEHOLDER_SEMVER,
  draftJson,
  error,
  idSchema,
  ifMatch,
  manifestChoiceSchema,
  type DraftKit,
} from "./shared.js";

/** Create kobe.skill.yaml in an open draft (KOBE-564) with the member's chosen model. */
export function draftManifestRoutes(kit: DraftKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, ctxOf, failure, json } = kit;

  /**
   * Create kobe.skill.yaml in an open draft (KOBE-564): the member's chosen model drafts it from
   * the draft's SKILL.md and files, and it is written at `If-Match`'s revision like any file.
   * The version number inside is a placeholder: Save version writes the number it saves as.
   */
  app.post("/:id/manifest", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const body = manifestChoiceSchema.safeParse((await json(c)) ?? {});
    if (!body.success)
      return error(c, 400, "invalid_request", "Give, optionally, a model alias and a license.");
    if (!deps.skillManifests)
      return error(
        c,
        503,
        "model_calls_unavailable",
        "This server has no model gateway for its own calls; write kobe.skill.yaml yourself.",
      );
    const ctx = ctxOf(c);
    // `visibleDraft` is the edit check too (`canEdit`): a draft the caller may not write is 404.
    const loaded = await withTeam(db, ctx.teamId, async (tx) => {
      const draft = await visibleDraft(tx, ctx.teamId, id.data, ctx.viewer);
      return draft ? { draft, files: await readAllFiles(tx, ctx.teamId, id.data) } : null;
    });
    if (!loaded) return error(c, 404, "not_found", "No such draft.");
    if (loaded.files.has(MANIFEST_PATH))
      return error(c, 409, "has_manifest", "This draft already has a kobe.skill.yaml.");
    if (loaded.draft.rev !== rev)
      return error(c, 409, "stale_revision", "This draft changed. Reload it to see the change.", {
        rev: loaded.draft.rev,
      });
    // Counted only once the draft is found and lacks a manifest (review L3).
    if (!(await hitRateLimit(db, `skill-manifest:${c.get("user").id}`, MANIFEST_RATE)))
      return error(c, 429, "rate_limited", "Too many manifests. Wait a few minutes and try again.");
    const made = await deps.skillManifests.generate({
      teamId: ctx.teamId,
      userId: ctx.viewer.userId,
      modelAlias: body.data.model,
      name: loaded.draft.name,
      semver: PLACEHOLDER_SEMVER,
      files: loaded.files,
      license: body.data.license,
    });
    if (!made.ok) {
      const status =
        made.code === "call_failed" || made.code === "not_serialisable"
          ? 502
          : made.code === "too_large"
            ? 413
            : made.code === "busy"
              ? 409
              : 422;
      return c.json(
        { code: made.code, message: made.message, ...(made.detail ? { detail: made.detail } : {}) },
        status,
      );
    }
    const result = await writeDraftFile(ctx, id.data, rev, MANIFEST_PATH, made.yaml);
    if (!result.ok) return failure(c, result);
    await withTeam(db, ctx.teamId, (tx) =>
      recordAudit(tx, {
        action: "skill.manifest.generated",
        teamId: ctx.teamId,
        target: { draftId: id.data, model: made.model.alias, from: made.source },
      }),
    );
    c.header("ETag", `"${result.draft.rev}"`);
    return c.json(
      {
        rev: result.draft.rev,
        draft: draftJson(result.draft, c.get("user").id),
        manifest: made.manifest,
        model: made.model.alias,
        source: made.source,
      },
      201,
    );
  });

  return app;
}
