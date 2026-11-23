import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { gitConversionStartBodySchema } from "@kobe/protocol";
import { fireAndLog } from "../async-util.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { conversionDeps } from "../git/conversion/deps.js";
import { runConversion } from "../git/conversion/runner.js";
import {
  abandonConversion,
  readProjectConversion,
  retryConversion,
  startConversion,
  type Outcome,
} from "../git/conversion/start.js";
import { invalidRequest, param, parseBody } from "../http/request.js";
import { logger } from "../logger.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const notFound = (c: Ctx) =>
  c.json({ code: "not_found", message: "No project with that id is available to you." }, 404);

const answer = <T>(c: Ctx, outcome: Outcome<T>, ok: (value: T) => Response): Response =>
  outcome.ok ? ok(outcome.value) : c.json(outcome.body, outcome.status as 400);

/**
 * Convert to repo (`/v1/projects/{id}/repo-conversion`, KOBE-765; spec workspace-git G15-G17,
 * GQ12, GQ13). The project's owner and Workspace admins start, retry and abandon; every member who
 * views the project reads the attempt (the dialog of KOBE-768 follows it until it completes or
 * fails). A start or retry answers 202 and the attempt runs on this replica right away; a restart
 * resumes it (`git-conversion-resume` job).
 */
export function projectRepoRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const conversion = conversionDeps(deps);
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  app.use(
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        c.json({ code: "too_large", message: "The request body is over 16 KiB." }, 413),
    }),
  );
  const viewer = (c: Ctx) => ({ teamId: c.get("team").id, userId: c.get("user").id });
  const kick = (teamId: string, id: string) =>
    fireAndLog(logger, "git conversion", runConversion(conversion, teamId, id), {
      team_id: teamId,
      conversion_id: id,
    });

  app.get("/:id/repo-conversion", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await readProjectConversion(conversion, viewer(c), id.data);
    return answer(c, out, (value) => c.json({ conversion: value }));
  });

  app.post("/:id/repo-conversion", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const body = await parseBody(c, gitConversionStartBodySchema);
    if (!body) {
      return invalidRequest(
        c,
        "Send connection_id, and optionally repository_name, visibility (private or internal), carry_history and use_existing.",
      );
    }
    const out = await startConversion(conversion, viewer(c), id.data, body);
    if (out.ok) kick(c.get("team").id, out.value.id);
    return answer(c, out, (value) => c.json({ conversion: value }, 202));
  });

  app.post("/:id/repo-conversion/retry", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await retryConversion(conversion, viewer(c), id.data);
    if (out.ok) kick(c.get("team").id, out.value.id);
    return answer(c, out, (value) => c.json({ conversion: value }, 202));
  });

  app.post("/:id/repo-conversion/abandon", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await abandonConversion(conversion, viewer(c), id.data);
    return answer(c, out, (value) => c.json(value));
  });

  return app;
}
