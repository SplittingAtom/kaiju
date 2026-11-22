import { projectCoreRoutes } from "./projects/core.js";
import { projectFileRoutes } from "./projects/files.js";
import { projectMemberRoutes } from "./projects/members.js";
import { projectKit } from "./projects/shared.js";
import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

/**
 * Projects API (KOBE-161 = 57c of KOBE-57, spec D23; Workspaces PR1-PR5, KOBE-578; contract
 * `packages/protocol/src/projects.ts` and `project-commits.ts`). Every decision is
 * `projectPermissions` through `projects/access.ts` (`decide`, `loadAccess`): contributors and team
 * admins create (and own what they create); readers view and converse; editors also upload and
 * remove files; owners manage the project and its people; team admins act as owners everywhere.
 * Every workspace member views every project of the workspace (RV1, KOBE-587); anyone outside
 * the workspace gets 404, as if it did not exist. Instructions are never written to the audit log.
 */
export function projectRoutes(
  deps: ServerDeps,
  sync?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));

  // The groups mount in their original order, after the team and permission checks.
  const kit = projectKit(deps, sync);
  app.route("/", projectCoreRoutes(kit));
  app.route("/", projectMemberRoutes(kit));
  app.route("/", projectFileRoutes(kit));
  return app;
}
