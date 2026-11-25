import { Hono } from "hono";
import { withTeam } from "@kaiju/db";
import { THREAD_STATS_RATE_LIMIT, type ThreadStats } from "@kaiju/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";
import { readThreadStats } from "../threads/stats.js";
import { invalidRequest, param } from "../http/request.js";

const NOT_FOUND = { code: "thread_not_found", message: "No thread with that id." };
const RATE_LIMITED = {
  code: "rate_limited",
  message: "Too many stats reads. Wait a minute and try again.",
};

/**
 * `GET /v1/threads/{id}/stats` (KOBE-842): the conversation's stats for the Context panel, read
 * from Postgres only (never a sandbox). Whoever may read the thread may read them, the same rule
 * as `GET /v1/threads/{id}/usage` (its owner, and members it is shared with through its project
 * or the team); anyone else gets the usual 404. The figures are counts and names already shown
 * to those readers elsewhere (run outcomes, tool cards, approvals, usage and cost), never content.
 */
export function threadStatsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.get("/:id/stats", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const db = deps.database.db;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    if (!(await hitRateLimit(db, `thread-stats:${userId}`, THREAD_STATS_RATE_LIMIT))) {
      return c.json(RATE_LIMITED, 429);
    }
    const stats = await withTeam(db, teamId, async (tx): Promise<ThreadStats | null> => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      if ((await findThread(tx, viewer, id.data)) === null) return null;
      return readThreadStats(tx, teamId, id.data);
    });
    if (stats === null) return c.json(NOT_FOUND, 404);
    c.header("cache-control", "private, no-store");
    return c.json(stats);
  });
  return app;
}
