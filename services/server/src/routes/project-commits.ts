import { projectCheckoutRoutes } from "./project-commits/checkouts.js";
import { projectCommitWriteRoutes } from "./project-commits/commits.js";
import { projectHistoryRoutes } from "./project-commits/history.js";
import { commitKit } from "./project-commits/shared.js";
import { Hono } from "hono";
import { withTeam } from "@kaiju/db";
import { PROJECT_HISTORY_MAX_COMMITS } from "@kaiju/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { myCheckouts } from "../projects/checkouts.js";
import { storageSettingsSchema, storageView, writeStorageSettings } from "../projects/storage.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { invalidRequest, parseBody } from "../http/request.js";

/**
 * Checkout, commit, update, discard, history and revert of a project (KOBE-579, Workspaces CM2-CM7;
 * contract `packages/protocol/src/project-commits.ts`), next to `routes/projects.ts` under
 * `/v1/projects`. Every route starts from `loadAccess` (every workspace member reads every project,
 * RV1; anyone else gets 404); readers read history, editors check out, commit and revert; owners and team admins
 * see the working copies.
 */
export function projectCommitRoutes(
  deps: ServerDeps,
  sync?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  // The groups mount in their original order, after the team and permission checks.
  const kit = commitKit(deps, sync);
  app.route("/", projectCheckoutRoutes(kit));
  app.route("/", projectCommitWriteRoutes(kit));
  app.route("/", projectHistoryRoutes(kit));
  return app;
}

/** `GET /v1/me/checkouts`: the caller's checkouts in the active workspace (KOBE-579). */
export function myCheckoutRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  app.get("/", async (c) => {
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    const list = await withTeam(deps.database.db, viewer.teamId, (tx) => myCheckouts(tx, viewer));
    return c.json({ checkouts: list });
  });
  return app;
}

/**
 * `GET/PUT /v1/team/storage` (team admins; KOBE-579, GV2, GV3, MT3): bytes and objects per
 * workspace, scratchspace and project, the limits in force, and the settings
 * `projects.history_keep`, `projects.max_mounted_per_member` and `max_objects` (audited).
 */
export function teamStorageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.projects.manage"));
  const limits = () => {
    const s = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    return {
      quotaDefaultBytes: s.defaultQuotaBytes,
      maxObjectsDefault: s.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      historyMaxCommits: s.projectHistoryMaxCommits ?? PROJECT_HISTORY_MAX_COMMITS,
    };
  };
  app.get("/", async (c) => {
    const teamId = c.get("team").id;
    return c.json(await withTeam(db, teamId, (tx) => storageView(tx, teamId, limits())));
  });
  app.put("/", async (c) => {
    const body = await parseBody(c, storageSettingsSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Send history_keep ({mode: all} or {mode: commits|days, n}), max_mounted_per_member or max_objects.",
      );
    }
    // GV2: a workspace may tighten the site's object budget, never raise it past the default.
    const ceiling = limits().maxObjectsDefault;
    if (body.max_objects !== undefined && body.max_objects !== null && body.max_objects > ceiling) {
      return invalidRequest(c, `max_objects may be at most the site default (${ceiling}).`);
    }
    const teamId = c.get("team").id;
    const view = await withTeam(db, teamId, async (tx) => {
      await writeStorageSettings(tx, teamId, c.get("user").id, body);
      return storageView(tx, teamId, limits());
    });
    return c.json(view);
  });
  return app;
}
