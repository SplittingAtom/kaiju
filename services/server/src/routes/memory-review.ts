import { Hono } from "hono";
import { z } from "zod";
import { withTeam } from "@kobe/db";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  candidateIdsSchema,
  dismissCandidate,
  saveAllMine,
  saveCandidate,
  saveCandidateSchema,
  undoSaves,
} from "../memory/review/decide.js";
import { workspaceOf } from "../memory/review/ids.js";
import { listReview } from "../memory/review/list.js";
import { markReviewSeen } from "../memory/review/notify.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";

const threadQuery = z.object({ thread_id: uuidSchema });

/**
 * To review (`/v1/memory/review`, KOBE-396, SM16): a thread author's learning candidates and
 * their decisions. Runs in the active Workspace (`user` scope rules of the memory route kit);
 * every decision is re-checked on the server (memory/review/decide.ts). Agents never decide.
 *
 * - `GET  /?thread_id=` the open candidates of the caller's thread
 * - `POST /candidates/:id/save` `{statement?, kind?, scope?, confirm_portable?, overrides?}`
 * - `POST /candidates/:id/dismiss`
 * - `POST /save-all` `{candidate_ids}`: Save all mine, one batch
 * - `POST /undo` `{candidate_ids}`: Undo of a save or a batch
 * - `POST /seen` `{thread_id}`: the panel showed the thread's candidates (bell notices read)
 */
export function memoryReviewRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);
  const candidateId = (raw: string | undefined) => uuidSchema.safeParse(raw);

  app.get("/", async (c) => {
    const q = threadQuery.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, "thread_id must be a conversation id.");
    return answer(c, "user", (who) => listReview(db, who, q.data.thread_id));
  });

  app.post("/candidates/:id/save", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, saveCandidateSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => saveCandidate(db, who, id.data, body.data));
  });

  app.post("/candidates/:id/dismiss", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    return answer(c, "user", (who) => dismissCandidate(db, who, id.data));
  });

  app.post("/save-all", async (c) => {
    const body = await readBody(c, candidateIdsSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => saveAllMine(db, who, body.data.candidate_ids));
  });

  app.post("/undo", async (c) => {
    const body = await readBody(c, candidateIdsSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => undoSaves(db, who, body.data.candidate_ids));
  });

  app.post("/seen", async (c) => {
    const body = await readBody(c, threadQuery.strict());
    if (!body.success) return invalidRequest(c, "thread_id must be a conversation id.");
    return answer(c, "user", async (who) => {
      const teamId = workspaceOf(who);
      const read = await withTeam(db, teamId, (tx) =>
        markReviewSeen(tx, { teamId, userId: who.userId, threadId: body.data.thread_id }),
      );
      return { read };
    });
  });

  return app;
}
