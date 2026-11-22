import type { Context } from "hono";
import { z } from "zod";
import { LICENSE_PATTERN } from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import type { TeamVariables } from "../../authz/middleware.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import type { ServerDeps } from "../../deps.js";
import { PostgresSkillStore, type SkillStore } from "../../skills/skill-store.js";
import { changelogSchema, semverSchema } from "../../skills/semver.js";
import { DRAFT_LIMITS, pathFromUrl } from "../../skills/drafts/files.js";
import type { DraftCursor, DraftFileInfo, DraftRecord } from "../../skills/drafts/records.js";
import type { DraftContext, DraftFailure } from "../../skills/drafts/service.js";
import type { StartResult } from "../../skills/drafts/starts.js";
import { TEMPLATE_IDS } from "../../skills/drafts/templates.js";
import { readJson } from "../../http/request.js";

export type Ctx = Context<{ Variables: TeamVariables }>;
type Status = 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503;

export const error = (c: Ctx, status: Status, code: string, message: string, extra = {}) =>
  c.json({ code, message, ...extra }, status);

export const idSchema = z.uuid();
const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
/** A draft has no number until Save version writes one into the manifest (`withSavedNumber`). */
export const PLACEHOLDER_SEMVER = "0.1.0";
export const createSchema = z.strictObject({
  name: z.string().regex(NAME),
  template: z.enum(TEMPLATE_IDS).optional(),
});
export const patchSchema = z.strictObject({ shared: z.boolean() });
export const destinationSchema = z.enum(["team", "personal"]);
/** Create kobe.skill.yaml in a draft (KOBE-564): the member's model and license choice. */
export const manifestChoiceSchema = z.strictObject({
  model: z.string().min(1).max(128).optional(),
  license: z.string().regex(LICENSE_PATTERN).optional(),
});
export const forkSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.enum(["team", "personal"]),
      skillId: z.uuid(),
      version: z.number().int().positive().optional(),
    }),
    z.strictObject({
      kind: z.literal("catalog"),
      skillId: z.uuid(),
      semver: semverSchema.optional(),
    }),
  ]),
  name: z.string().regex(NAME).optional(),
});
export const fromWorkspaceSchema = z.strictObject({
  threadId: z.uuid(),
  folder: z.string().regex(NAME),
});
export const saveSchema = z.strictObject({
  destination: z.enum(["team", "personal"]),
  semver: semverSchema,
  changelog: changelogSchema,
  confirmPersonal: z.boolean().optional(),
});

export const draftJson = (d: DraftRecord, viewerId: string) => ({
  id: d.id,
  name: d.name,
  shared: d.shared,
  mine: d.ownerUserId === viewerId,
  ownerUserId: d.ownerUserId,
  startedFrom: d.startedFrom,
  parentRef: d.parentRef,
  origin: d.origin,
  fromConversation: d.startedFrom === "thread",
  coEdited: d.coEdited,
  rev: d.rev,
  sizeBytes: d.sizeBytes,
  fileCount: d.fileCount,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

export const fileJson = (f: DraftFileInfo) => ({
  path: f.path,
  size: f.size,
  kind: f.kind,
  updatedAt: f.updatedAt,
});

/** The revision in `If-Match` (`"7"`, `W/"7"` or `7`); null when absent or malformed. */
export function ifMatch(c: Ctx): number | null {
  const raw = c.req.header("if-match")?.trim();
  const m = raw ? /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(raw) : null;
  const rev = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(rev) && rev <= 2147483647 ? rev : null;
}

/** The file path after `/<id>/files/`, decoded segment by segment. */
export function filePath(c: Ctx, id: string): string | null {
  const pathname = new URL(c.req.url).pathname;
  const marker = `/${id}/files/`;
  const at = pathname.indexOf(marker);
  return at < 0 ? null : pathFromUrl(pathname.slice(at + marker.length));
}

export const NO_DRAFTS = "Your team role doesn't allow drafts.";

/** What every draft route group shares: one skill store per router and the reply helpers. */
export interface DraftKit {
  readonly deps: ServerDeps;
  readonly db: KobeDb;
  readonly skillStore: () => SkillStore | null;
  readonly ctxOf: (c: Ctx) => DraftContext;
  readonly failure: (c: Ctx, f: DraftFailure) => Response | Promise<Response>;
  readonly json: (c: Ctx) => Promise<unknown>;
  readonly mayStart: (c: Ctx) => boolean;
  readonly started: (c: Ctx, result: StartResult) => Response | Promise<Response>;
}

export function draftKit(deps: ServerDeps): DraftKit {
  const db = deps.database.db;
  let made: SkillStore | null | undefined;
  const skillStore = (): SkillStore | null =>
    (made ??= deps.blobs ? new PostgresSkillStore(db, deps.blobs) : null);

  const ctxOf = (c: Ctx): DraftContext => ({
    db,
    teamId: c.get("team").id,
    viewer: { userId: c.get("user").id, role: c.get("team").role },
  });

  const failure = (c: Ctx, f: DraftFailure) => {
    switch (f.error) {
      case "not_found":
        return error(c, 404, "not_found", "No such draft or file.");
      case "forbidden":
        return error(c, 403, "forbidden", f.message);
      case "stale_revision":
        return error(
          c,
          409,
          "stale_revision",
          `This draft was changed by ${f.changedBy.name}. Reload it to see their changes.`,
          { rev: f.rev, changedBy: f.changedBy },
        );
      case "invalid_path":
        return error(c, 400, "invalid_path", f.message);
      case "too_many_files":
        return error(c, 422, f.error, `A draft may have at most ${DRAFT_LIMITS.maxFiles} files.`);
      case "draft_limit":
        return error(
          c,
          422,
          f.error,
          `You have ${DRAFT_LIMITS.maxDraftsPerAuthor} drafts in this team. Delete one first.`,
        );
      case "draft_too_large":
      case "file_too_large":
        return error(c, 413, f.error, f.message);
      case "name_taken":
        return error(c, 409, "name_taken", f.message);
      case "not_sync_target":
        return error(c, 409, "not_sync_target", "This draft is no longer saved into.");
    }
  };

  const json = async (c: Ctx): Promise<unknown> => readJson(c, undefined);

  const mayStart = (c: Ctx) => teamRoleAllows(c.get("team").role, "team.personal.create");
  const started = (c: Ctx, result: StartResult) => {
    if (result.ok) return c.json({ draft: draftJson(result.draft, c.get("user").id) }, 201);
    if (result.error === "invalid_bundle")
      return error(
        c,
        result.bundle.code === "bundle_too_large" || result.bundle.code === "file_too_large"
          ? 413
          : 400,
        result.bundle.code,
        result.bundle.message,
      );
    return failure(c, result);
  };

  return { deps, db, skillStore, ctxOf, failure, json, mayStart, started };
}

/** Reads the body up to `max` bytes; null when it (or its declared length) is longer. */
export async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export const encodeCursor = (c: DraftCursor): string =>
  Buffer.from(`${c.updatedAt}|${c.id}`).toString("base64url");

/** The cursor of `GET /?cursor=`; undefined when malformed. */
export function decodeCursor(raw: string): DraftCursor | undefined {
  const [at, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
  if (
    extra !== undefined ||
    !at ||
    !instant.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    !idSchema.safeParse(id).success
  )
    return undefined;
  return { updatedAt: at, id: id as string };
}
