import { Hono } from "hono";
import {
  createScheduleBodySchema,
  listSchedulesQuerySchema,
  type CreateScheduleBody,
} from "@kaiju/protocol";
import { withTeam } from "@kaiju/db";
import { type TeamVariables } from "../../authz/middleware.js";
import {
  NOT_ALLOWED,
  parseScheduleBody,
  scheduleError,
  send,
  type Answer,
} from "../../schedules/http.js";
import {
  agentRunnable,
  countActiveElsewhere,
  countActiveHere,
  insertSchedule,
  listSchedules,
  nextDueAt,
  toResponse,
} from "../../schedules/store.js";
import { invalidRequest } from "../../http/request.js";
import { OPERATION_LIMITS, admitOperation, rateLimited } from "../../operation-limits.js";
import { MARKERS_REFUSED, serverMarkers, mentionsAnswer, type ScheduleKit } from "./shared.js";

/** The caller's schedules (team admins: the team's) and creating one. */
export function scheduleListRoutes(kit: ScheduleKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, isAdmin, otherTeams, inTeam, capAnswer } = kit;

  app.get("/", async (c) => {
    const query = listSchedulesQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    if (query.data.scope === "team" && !isAdmin(c)) return send(c, NOT_ALLOWED);
    const elsewhere = await countActiveElsewhere(db, userId, await otherTeams(userId, teamId));
    return withTeam(db, teamId, async (tx) => {
      const rows = await listSchedules(tx, teamId, query.data.scope === "team" ? null : userId);
      const activeCount = elsewhere + (await countActiveHere(tx, teamId, userId));
      return c.json({ schedules: rows.map(toResponse), active_count: activeCount });
    });
  });

  app.post("/", async (c) => {
    const parsed = await parseScheduleBody<CreateScheduleBody>(c, createScheduleBodySchema);
    if (!parsed.ok) return send(c, parsed.answer);
    const body = parsed.data;
    if (serverMarkers(body.prompt)) return invalidRequest(c, MARKERS_REFUSED);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const limit = OPERATION_LIMITS.scheduleCreate; // KOBE-813, per member across Workspaces
    const verdict = await admitOperation(db, limit, userId);
    if (!verdict.allowed) return rateLimited(c, limit, verdict);
    const due = body.active ? nextDueAt(body.recurrence, body.tz) : null;
    if (body.active && due === null) return send(c, scheduleError("invalid_recurrence"));
    const answer = await inTeam(
      teamId,
      userId,
      body.active,
      async (tx, elsewhere): Promise<Answer> => {
        if (!(await agentRunnable(tx, { teamId, userId }, body.agent_id))) {
          return scheduleError("agent_not_runnable");
        }
        const blocked = body.active ? await capAnswer(tx, userId, teamId, elsewhere, userId) : null;
        if (blocked) return blocked;
        const refused = await mentionsAnswer(tx, { teamId, userId }, body.mentions);
        if (refused) return refused;
        const row = await insertSchedule(tx, {
          teamId,
          userId,
          agentId: body.agent_id,
          prompt: body.prompt,
          mentions: body.mentions,
          recurrence: body.recurrence,
          tz: body.tz,
          active: body.active,
          notifyEmail: body.notify_email,
          nextDueAt: due,
        });
        return { status: 201, json: toResponse(row) };
      },
    );
    return send(c, answer);
  });

  return app;
}
