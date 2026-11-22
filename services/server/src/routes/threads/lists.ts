import { Hono } from "hono";
import { withTeam } from "@kobe/db";
import { type TeamVariables } from "../../authz/middleware.js";
import {
  clearTestThreads,
  listOwnOrganized,
  listSharedWithMe,
  listThreads,
  listTrash,
} from "../../threads/repository.js";
import {
  clearTestThreadsQuerySchema,
  listThreadsQuerySchema,
  pinnedQuerySchema,
  trashQuerySchema,
} from "../../threads/schemas.js";
import { searchThreadList } from "../../threads/search.js";
import { listThreadActivity } from "../../threads/activity.js";
import { invalidRequest } from "../../http/request.js";
import { fail, parseQuery, cursorParam, pageBody, type ThreadKit } from "./shared.js";

/**
 * The thread lists: search and pages, the rail's activity, Trash, Shared with me, Pinned and
 * Archived; clearing test threads.
 */
export function threadListRoutes(kit: ThreadKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, asViewer } = kit;

  app.get("/", async (c) => {
    const query = parseQuery(c, listThreadsQuerySchema);
    if (!query) return invalidRequest(c);
    // A folder's list (KOBE-534) is its own view: not a search, not a project's list.
    if (query.folder !== undefined && (query.q !== undefined || query.project_id !== undefined)) {
      return invalidRequest(c, "folder can't be combined with q or project_id.");
    }
    if (query.q !== undefined) {
      const { q, project_id, cursor, limit } = query;
      const result = await asViewer(c, (tx, viewer) =>
        searchThreadList(tx, viewer, { query: q, projectId: project_id, cursor, limit }),
      );
      return result.ok ? c.json(result.body) : fail(c, result.error);
    }
    const cursor = cursorParam(query.cursor);
    if (cursor === undefined) return fail(c, "invalid_cursor");
    const page = await asViewer(c, (tx, viewer) =>
      listThreads(tx, viewer, {
        projectId: query.project_id,
        folder: query.folder,
        cursor,
        limit: query.limit,
      }),
    );
    return c.json(pageBody(page));
  });

  // The rail's run and approval dots (KOBE-301): polled, so one cheap query and no project read.
  app.get("/activity", async (c) => {
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    return c.json(await withTeam(db, viewer.teamId, (tx) => listThreadActivity(tx, viewer)));
  });

  app.get("/trash", async (c) => {
    const query = parseQuery(c, trashQuerySchema);
    if (!query) return invalidRequest(c);
    const cursor = cursorParam(query.cursor);
    if (cursor === undefined) return fail(c, "invalid_cursor");
    const page = await asViewer(c, (tx, viewer) =>
      listTrash(tx, viewer, { cursor, limit: query.limit }),
    );
    return c.json(pageBody(page));
  });

  // Shared with me (CE20, KOBE-221): others' threads shared with the caller, newest activity first.
  app.get("/shared", async (c) => {
    const query = parseQuery(c, trashQuerySchema);
    if (!query) return invalidRequest(c);
    const cursor = cursorParam(query.cursor);
    if (cursor === undefined) return fail(c, "invalid_cursor");
    const page = await asViewer(c, (tx, viewer) =>
      listSharedWithMe(tx, viewer, { cursor, limit: query.limit }),
    );
    return c.json(pageBody(page));
  });

  // The rail's Pinned and Archived groups (CE19, KOBE-220): the caller's own, newest first.
  // Pinned takes the folder filter (KOBE-534, TF5); Archived lists every folder's.
  for (const which of ["pinned", "archived"] as const) {
    app.get(`/${which}`, async (c) => {
      const query = parseQuery(c, pinnedQuerySchema);
      if (!query || (which === "archived" && query.folder !== undefined)) return invalidRequest(c);
      const cursor = cursorParam(query.cursor);
      if (cursor === undefined) return fail(c, "invalid_cursor");
      const page = await asViewer(c, (tx, viewer) =>
        listOwnOrganized(tx, viewer, { which, folder: query.folder, cursor, limit: query.limit }),
      );
      return c.json(pageBody(page));
    });
  }

  // Before `/:id`: clears the caller's own builder test threads (KOBE-85).
  app.delete("/test", async (c) => {
    const query = parseQuery(c, clearTestThreadsQuerySchema);
    if (!query) return invalidRequest(c, "agent_id must be an agent id.");
    const cleared = await asViewer(c, (tx, viewer) =>
      clearTestThreads(tx, viewer, { agentId: query.agent_id }),
    );
    return c.json({ cleared });
  });

  return app;
}
