import { Hono } from "hono";
import { patchScheduleBodySchema, type PatchScheduleBody } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { type TeamVariables } from "../../authz/middleware.js";
import { uuidSchema } from "../../threads/schemas.js";
import {
  NOT_FOUND,
  PAUSED_BY_ADMIN,
  parseScheduleBody,
  scheduleError,
  send,
  type Answer,
} from "../../schedules/http.js";
import { agentRunnable, nextDueAt, toResponse, updateSchedule } from "../../schedules/store.js";
import { invalidRequest, param } from "../../http/request.js";
import {
  MARKERS_REFUSED,
  serverMarkers,
  mentionsAnswer,
  agentBack,
  type ScheduleKit,
} from "./shared.js";

/** Reading and changing one of the caller's schedules. */
export function scheduleEditRoutes(kit: ScheduleKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, inTeam, capAnswer, loadOwn } = kit;

  app.get("/:id", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await loadOwn(tx, teamId, userId, id.data);
      return row ? { status: 200, json: toResponse(row) } : NOT_FOUND;
    });
    return send(c, answer);
  });

  app.patch("/:id", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const parsed = await parseScheduleBody<PatchScheduleBody>(c, patchScheduleBodySchema);
    if (!parsed.ok) return send(c, parsed.answer);
    const patch = parsed.data;
    if (patch.prompt !== undefined && serverMarkers(patch.prompt)) {
      return invalidRequest(c, MARKERS_REFUSED);
    }
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const answer = await inTeam(
      teamId,
      userId,
      patch.active === true,
      async (tx, elsewhere): Promise<Answer> => {
        const row = await loadOwn(tx, teamId, userId, id.data);
        if (!row) return NOT_FOUND;
        if (patch.active === true && row.pausedBy === "team_admin") return PAUSED_BY_ADMIN;
        if (patch.active === true && !(await agentBack(tx, row, patch.agent_id))) {
          return scheduleError("agent_not_runnable");
        }
        if (patch.agent_id !== undefined && patch.agent_id !== row.agentId) {
          if (!(await agentRunnable(tx, { teamId, userId }, patch.agent_id))) {
            return scheduleError("agent_not_runnable");
          }
        }
        if (patch.mentions !== undefined) {
          const refused = await mentionsAnswer(tx, { teamId, userId }, patch.mentions);
          if (refused) return refused;
        }
        const active = patch.active ?? row.active;
        const activating = active && !row.active;
        if (activating) {
          const blocked = await capAnswer(tx, userId, teamId, elsewhere, userId);
          if (blocked) return blocked;
        }
        const recurrence = patch.recurrence ?? (row.recurrence as typeof patch.recurrence & object);
        const tz = patch.tz ?? row.tz;
        const reschedule =
          activating || (active && (patch.recurrence !== undefined || patch.tz !== undefined));
        const due = reschedule ? nextDueAt(recurrence, tz) : undefined;
        if (reschedule && due === null) return scheduleError("invalid_recurrence");
        const updated = await updateSchedule(
          tx,
          row,
          {
            ...(patch.agent_id !== undefined ? { agentId: patch.agent_id } : {}),
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            ...(patch.mentions !== undefined ? { mentions: patch.mentions } : {}),
            ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
            ...(patch.tz !== undefined ? { tz: patch.tz } : {}),
            ...(patch.notify_email !== undefined ? { notifyEmail: patch.notify_email } : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
            ...(active ? {} : { nextDueAt: null }),
            ...(activating ? { pausedBy: null } : {}),
            ...(due !== undefined ? { nextDueAt: due } : {}),
            // An owner's pause never clears a team admin's: only an admin resumes that.
            ...(patch.active === false && row.pausedBy !== "team_admin" ? { pausedBy: null } : {}),
          },
          {
            fieldsChanged: Object.keys(patch).some((k) => k !== "active"),
            activation: active === row.active ? null : active ? "activated" : "deactivated",
            by: "owner",
          },
        );
        return { status: 200, json: toResponse(updated) };
      },
    );
    return send(c, answer);
  });

  return app;
}
