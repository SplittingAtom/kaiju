import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { refuseEvalThreadWrites } from "./eval-thread-guard.js";
import { threadCreateRoutes } from "./threads/create.js";
import { threadEditRoutes } from "./threads/edits.js";
import { threadListRoutes } from "./threads/lists.js";
import { threadOrganizeRoutes } from "./threads/organize.js";
import { threadReadRoutes } from "./threads/reads.js";
import { threadKit } from "./threads/shared.js";

/**
 * Thread API (spec §6.1, D9, D15, D18, D23): create, list (keyset pagination), read with entries,
 * rename, share to project, switch branch (leaf), Trash and restore. Team-scoped: the team comes
 * from the session's active team (never from the request), every query runs in `withTeam`, and
 * every route needs `team.chat`. Reads touch only Postgres and never wake a sandbox (D14, U15).
 * Messages and runs (`POST /v1/threads/{id}/messages`, `/v1/runs/*`) belong to the run
 * orchestrator (KOBE-30). Search (`?q=`) is `threads/search.ts` (KOBE-33).
 */
export function threadRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  // KOBE-325: a skill eval's thread is the eval runner's (reads stay open to its owner).
  app.use("/:id", refuseEvalThreadWrites(deps, "thread"));
  app.use("/:id/*", refuseEvalThreadWrites(deps, "thread"));

  // The groups mount in their original order, after the team, permission and eval guards.
  const kit = threadKit(deps);
  app.route("/", threadListRoutes(kit));
  app.route("/", threadCreateRoutes(kit));
  app.route("/", threadReadRoutes(kit));
  app.route("/", threadEditRoutes(kit));
  app.route("/", threadOrganizeRoutes(kit));
  return app;
}
