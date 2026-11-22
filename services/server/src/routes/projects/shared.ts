import type { Context } from "hono";
import { z } from "zod";
import { withTeam, type KobeTx, isUniqueViolation } from "@kobe/db";
import { type ProjectAction } from "@kobe/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import type { ServerDeps } from "../../deps.js";
import { loadAccess, type ProjectAccess } from "../../projects/access.js";
import { type ImportRefusal } from "../../projects/import.js";
import type { WorkspaceSync } from "../../workspace-sync/service.js";
import { type ProjectFileFailure } from "../../projects/files.js";
import { type ProjectFailure } from "../../projects/repository.js";
import { param } from "../../http/request.js";

export type ProjectContext = Context<{ Variables: TeamVariables }>;

export const ERRORS = {
  not_found: [404, "not_found", "No project with that id is available to you."],
  forbidden: [403, "forbidden", "Your project role doesn't allow that."],
  slug_taken: [409, "slug_taken", "Another project in this team already uses that slug."],
  already_exists: [409, "already_exists", "That user is already a member of the project."],
  last_owner: [
    409,
    "last_owner",
    "A project needs at least one owner. Make someone else owner first.",
  ],
  not_in_team: [422, "not_in_team", "Every member must belong to this team."],
  invalid_agent: [
    422,
    "invalid_input",
    "The default agent must be a published, active team or gallery agent; personal agents can't be a project default.",
  ],
  archived: [409, "archived", "The project is archived."],
  in_use: [409, "project_in_use", "The project still has content."],
  uncommitted_work: [
    409,
    "uncommitted_work",
    "Members have uncommitted changes in working copies of this project; confirm again to discard them.",
  ],
  legal_hold: [409, "forbidden", "The team is under a legal hold: the project's history stays."],
  user_deactivated: [
    422,
    "invalid_input",
    "That account is deactivated; make an active member the owner.",
  ],
} as const satisfies Record<ProjectFailure, readonly [number, string, string]>;

export function failure(c: Context, error: ProjectFailure, detail?: string) {
  const [status, code, message] = ERRORS[error];
  return c.json(
    { code, message: detail === undefined ? message : `${message} Remove first: ${detail}.` },
    status,
  );
}

export const FILE_ERRORS = {
  invalid_path: [422, "invalid_input", "That is not a valid file name or folder."],
  path_too_long: [
    422,
    "invalid_input",
    "That path is too long once it is in the project folder (projects/<slug>/…): use a shorter folder or name.",
  ],
  already_exists: [409, "already_exists", "The project already has a file with that name."],
  path_clash: [
    409,
    "already_exists",
    "A file and a folder of the project would have the same name: pick another folder or name.",
  ],
  file_too_large: [413, "file_too_large", "That file is larger than a project file may be."],
  quota_exceeded: [507, "quota_exceeded", "Your team has no storage left for this file."],
  object_budget: [
    507,
    "quota_exceeded",
    "Your workspace holds as many stored objects as its budget allows.",
  ],
  project_full: [507, "quota_exceeded", "The project already holds the most files it can."],
  archived: [409, "archived", "The project is archived."],
  storage_failed: [503, "storage_unavailable", "File storage is not available. Try again."],
} as const satisfies Record<ProjectFileFailure, readonly [number, string, string]>;

/** Add to project (KOBE-585): the refusals before the copy; the rest are {@link FILE_ERRORS}. */
export const IMPORT_ERRORS = {
  project_not_found: [404, "not_found", "No project with that id is available to you."],
  source_not_found: [404, "not_found", "No such artifact version or file is available to you."],
  forbidden: [403, "forbidden", "You can't add that to this project."],
  invalid_name: [422, "invalid_input", "That is not a valid file name."],
  content_unavailable: [503, "storage_unavailable", "File storage is not available. Try again."],
  content_missing: [503, "content_missing", "The file's saved copy is missing; try again shortly."],
} as const satisfies Record<ImportRefusal, readonly [number, string, string]>;

/** Multipart framing allowed on top of the file itself. */
export const MULTIPART_OVERHEAD = 64 * 1024;

export const idParam = z.uuid();
export const SLUG_UNIQUE = "projects_slug_unique";

export function isSlugConflict(err: unknown): boolean {
  return isUniqueViolation(err, SLUG_UNIQUE);
}

export type ProjectKit = ReturnType<typeof projectKit>;

/** What the project route groups share: the caller's access to `:id` in one team transaction. */
export function projectKit(deps: ServerDeps, sync: WorkspaceSync | undefined) {
  const db = deps.database.db;

  const viewerOf = (c: ProjectContext) => ({ teamId: c.get("team").id, userId: c.get("user").id });

  /** Runs `fn` with the caller's access to `:id` (404 if none, 403 if `action` is not allowed). */
  const withProject = async (
    c: ProjectContext,
    action: ProjectAction,
    fn: (tx: KobeTx, access: ProjectAccess) => Promise<Response>,
  ): Promise<Response> => {
    const id = param(c, "id", idParam);
    if (!id.success) return failure(c, "not_found");
    const viewer = viewerOf(c);
    try {
      return await withTeam(db, viewer.teamId, async (tx) => {
        const access = await loadAccess(tx, viewer, id.data, { lock: action !== "view" });
        if (!access) return failure(c, "not_found");
        if (!access.can[action]) return failure(c, "forbidden");
        return fn(tx, access);
      });
    } catch (err) {
      if (isSlugConflict(err)) return failure(c, "slug_taken");
      throw err;
    }
  };

  return { deps, db, sync, viewerOf, withProject };
}
