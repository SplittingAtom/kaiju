import { type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../../auth/session.js";
import type { ServerDeps } from "../../deps.js";
import { logger } from "../../logger.js";
import { DRAFT_LIMITS, pathFromUrl } from "../../skills/drafts/files.js";
import { changelogSchema, semverSchema } from "../../skills/semver.js";
import { type KobeDeps } from "../../skills/site-edit/kobe-detach.js";
import { type SiteDraftFailure, type SiteDraftRecord } from "../../skills/site-edit/site-drafts.js";
import { type PublishFailure } from "../../skills/site-edit/site-publish.js";
import { param } from "../../http/request.js";

export type Ctx = Context<{ Variables: AuthVariables }>;
export type Status = 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503;

export const error = (c: Ctx, status: Status, code: string, message: string, extra = {}) =>
  c.json({ code, message, ...extra }, status);

export const idSchema = z.uuid();
export const startSchema = z.strictObject({ versionId: z.uuid(), replace: z.boolean().optional() });
export const publishSchema = z.strictObject({ semver: semverSchema, changelog: changelogSchema });

/** The revision in `If-Match` (`"7"`, `W/"7"` or `7`); null when absent or malformed. */
export function ifMatch(c: Ctx): number | null {
  const raw = c.req.header("if-match")?.trim();
  const m = raw ? /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(raw) : null;
  const rev = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(rev) && rev <= 2147483647 ? rev : null;
}

/** The file path after `marker` in the URL, decoded segment by segment. */
export function pathAfter(c: Ctx, marker: string): string | null {
  const pathname = new URL(c.req.url).pathname;
  const at = pathname.indexOf(marker);
  return at < 0 ? null : pathFromUrl(pathname.slice(at + marker.length));
}

export const draftJson = (d: SiteDraftRecord) => ({
  id: d.id,
  skillId: d.skillId,
  baseVersionId: d.baseVersionId,
  rev: d.rev,
  sizeBytes: d.sizeBytes,
  fileCount: d.fileCount,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

export type CatalogEditKit = ReturnType<typeof catalogEditKit>;

/** What the catalog editor's route groups share: storage, the Kobe sync deps and the replies. */
export function catalogEditKit(deps: ServerDeps) {
  const db = deps.database.db;
  const blobsOr = (_c: Ctx) => deps.blobs ?? null;
  const unavailable = (c: Ctx) =>
    error(c, 503, "skills_unavailable", "Skill storage is not configured.");
  const kobeDeps = (): KobeDeps | null =>
    deps.blobs ? { db, blobs: deps.blobs, log: logger } : null;

  const failure = (c: Ctx, f: SiteDraftFailure | PublishFailure) => {
    switch (f.error) {
      case "forbidden":
        return error(c, 403, "forbidden", "You don't have permission to do that.");
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill, version, draft or file.");
      case "retired":
        return error(
          c,
          409,
          "skill_retired",
          "This skill is deprecated or archived. Restore it before editing it.",
        );
      case "blocklisted":
        return error(
          c,
          422,
          "skill_blocklisted",
          "This skill's bytes are on the Site's blocklist. Unblock them before editing it.",
        );
      case "not_stored":
        return error(c, 409, "not_stored", "That version's files are not in the store.");
      case "draft_exists":
        return error(
          c,
          409,
          "draft_exists",
          `A site draft of this skill exists (changed by ${f.draft.updatedBy}). Continue it or replace it.`,
          { draft: f.draft },
        );
      case "stale_revision":
        return error(
          c,
          409,
          "stale_revision",
          `This draft was changed by ${f.changedBy}. Reload it to see their changes.`,
          { rev: f.rev, changedBy: { name: f.changedBy } },
        );
      case "too_many_files":
        return error(c, 422, f.error, `A draft may have at most ${DRAFT_LIMITS.maxFiles} files.`);
      case "invalid_path":
        return error(c, 400, "invalid_path", f.message);
      case "not_published":
        return error(c, 409, "not_published", f.message);
      case "file_too_large":
      case "draft_too_large":
        return error(c, 413, f.error, f.message);
      case "skill_md_missing":
      case "invalid_package":
      case "name_changed":
        return error(c, 422, f.error, f.message);
      case "semver_not_increasing":
        return error(c, 409, f.error, f.message);
      case "scan_busy":
        c.header("Retry-After", String(f.retryAfter ?? 10));
        return error(c, 429, "scan_busy", f.message);
      case "scan_block": {
        const { verdict, findings, scripts, skipped } = f.scan;
        return error(c, 422, "scan_block", f.message, {
          scan: { verdict, findings, scripts, skipped },
        });
      }
    }
  };

  const skillId = (c: Ctx) => {
    const id = param(c, "skillId", idSchema);
    return id.success ? id.data : null;
  };

  return { deps, db, blobsOr, unavailable, kobeDeps, failure, skillId };
}
