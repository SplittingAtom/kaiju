import { scheduleListRoutes } from "./schedules/create.js";
import { scheduleEditRoutes } from "./schedules/edit.js";
import { scheduleStateRoutes } from "./schedules/state.js";
import { scheduleKit } from "./schedules/shared.js";
import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

/**
 * Schedules API (KOBE-173, spec D32; contract in @kobe/protocol `schedules.ts`): a member's
 * personal scheduled runs in the active team. Everything is scoped to the owner and the team
 * under RLS; someone else's schedule, or another team's, is a 404 like a missing one. Team
 * admins (`team.schedules.pause`) see the team's inventory and pause or resume, nothing else.
 * Nothing here fires a schedule (the runner is KOBE-174).
 */
export function scheduleRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.schedules.personal"));
  // The groups mount in their original order, after the team and permission checks.
  const kit = scheduleKit(deps);
  app.route("/", scheduleListRoutes(kit));
  app.route("/", scheduleEditRoutes(kit));
  app.route("/", scheduleStateRoutes(kit));
  return app;
}
