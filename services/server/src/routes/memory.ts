import { memoryDocRoutes } from "./memory/docs.js";
import { memoryHistoryRoutes } from "./memory/history.js";
import { memoryKit } from "./memory/shared.js";
import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

/**
 * Memory panel API (`/v1/memory`, KOBE-155; contract `packages/protocol/src/memory.ts`, spec D24).
 * Personal memory is the caller's own: another member's doc is a 404, also for team admins (only
 * break-glass reads it). Project memory is read by every reader of the project and changed by
 * editors, owners and team admins (`projectMemoryAccess`, PR6: a reader's write is 403
 * `read_only`). Each scope also needs its switches on (`memory_disabled`, 403). Every
 * query runs under `withTeam`; content comes from the object store; audit events carry ids and
 * versions, never paths or content. Panel edits apply at once (also for `project`).
 */
export function memoryRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  // The groups mount in their original order, after the team and permission checks.
  const kit = memoryKit(deps);
  app.route("/", memoryDocRoutes(kit));
  app.route("/", memoryHistoryRoutes(kit));
  return app;
}
