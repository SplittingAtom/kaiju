import { Hono } from "hono";
import { withTeam } from "@kaiju/db";
import { type TeamVariables } from "../../authz/middleware.js";
import { principalActive } from "../../runs/store.js";
import { uuidSchema } from "../../threads/schemas.js";
import {
  NOT_FOUND,
  OWNER_INACTIVE,
  PAUSED_BY_ADMIN,
  scheduleError,
  send,
  CHANGED_SINCE_APPROVAL,
  type Answer,
} from "../../schedules/http.js";
import {
  deleteSchedule,
  findSchedule,
  nextDueAt,
  toResponse,
  updateSchedule,
} from "../../schedules/store.js";
import { invalidRequest, param } from "../../http/request.js";
import { agentBack, type ScheduleKit } from "./shared.js";

/** Deleting, pausing and resuming a schedule (team admins pause and resume anyone's). */
export function scheduleStateRoutes(kit: ScheduleKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, isAdmin, inTeam, capAnswer, loadOwn } = kit;

  app.delete("/:id", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await loadOwn(tx, teamId, userId, id.data);
      if (!row) return NOT_FOUND;
      await deleteSchedule(tx, row);
      return { status: 204 };
    });
    return send(c, answer);
  });

  app.post("/:id/pause", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const admin = isAdmin(c);
    // `?expectedActive=true` (KOBE-621): the approved before-state; a paused one is a 409.
    const expectActive = c.req.query("expectedActive") === "true";
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await findSchedule(tx, teamId, id.data);
      const own = row?.userId === userId;
      if (!row || (!own && !admin)) return NOT_FOUND;
      if (!row.active && expectActive) return CHANGED_SINCE_APPROVAL;
      if (!row.active) return { status: 200, json: toResponse(row) };
      const by = own ? "owner" : "team_admin";
      const updated = await updateSchedule(
        tx,
        row,
        { active: false, nextDueAt: null, pausedBy: by === "owner" ? null : "team_admin" },
        { fieldsChanged: false, activation: "deactivated", by },
      );
      return { status: 200, json: toResponse(updated) };
    });
    return send(c, answer);
  });

  app.post("/:id/resume", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const admin = isAdmin(c);
    // `?expectedActive=false` (KOBE-621): the approved before-state; an active one is a 409.
    const expectPaused = c.req.query("expectedActive") === "false";
    // The cap is the owner's, who is not the caller when a team admin resumes.
    const owner = await withTeam(db, teamId, (tx) =>
      findSchedule(tx, teamId, id.data).then((r) => r?.userId ?? null),
    );
    if (owner === null || (owner !== userId && !admin)) return send(c, NOT_FOUND);
    const answer = await inTeam(teamId, owner, true, async (tx, elsewhere): Promise<Answer> => {
      const row = await findSchedule(tx, teamId, id.data);
      const own = row?.userId === userId;
      if (!row || (!own && !admin)) return NOT_FOUND;
      if (row.active && expectPaused) return CHANGED_SINCE_APPROVAL;
      if (!own && row.pausedBy !== "team_admin") return NOT_FOUND;
      if (row.active) return { status: 200, json: toResponse(row) };
      if (own && row.pausedBy === "team_admin") return PAUSED_BY_ADMIN;
      if (!(await agentBack(tx, row))) return scheduleError("agent_not_runnable");
      // An admin never revives a deactivated or removed owner's schedule (KOBE-180 review).
      if (!own && !(await principalActive(tx, teamId, row.userId))) return OWNER_INACTIVE;
      const blocked = await capAnswer(tx, row.userId, teamId, elsewhere, userId);
      if (blocked) return blocked;
      const due = nextDueAt(row.recurrence as Parameters<typeof nextDueAt>[0], row.tz);
      if (due === null) return scheduleError("invalid_recurrence");
      const updated = await updateSchedule(
        tx,
        row,
        { active: true, nextDueAt: due, pausedBy: null },
        { fieldsChanged: false, activation: "activated", by: own ? "owner" : "team_admin" },
      );
      return { status: 200, json: toResponse(updated) };
    });
    return send(c, answer);
  });

  return app;
}
