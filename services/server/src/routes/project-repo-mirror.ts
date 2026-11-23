import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { gitRepoRelinkBodySchema } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { mirrorDeps } from "../git/mirror/deps.js";
import {
  detachRepo,
  readRepo,
  refreshRepo,
  relinkRepo,
  type Outcome,
} from "../git/mirror/manage.js";
import { invalidRequest, param, parseBody } from "../http/request.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const notFound = (c: Ctx) =>
  c.json({ code: "not_found", message: "No project with that id is available to you." }, 404);

const answer = <T>(c: Ctx, outcome: Outcome<T>, ok: (value: T) => Response): Response => {
  if (outcome.ok) return ok(outcome.value);
  const retry = outcome.body.retry_after_seconds;
  if (typeof retry === "number") c.header("Retry-After", String(retry));
  return c.json(outcome.body, outcome.status as 400);
};

/**
 * The Repo mirror (`/v1/projects/{id}/repo*`, KOBE-766; spec workspace-git G17, G20). Every member
 * who views the project reads the Repo (its repository, mirror state and newest commits; opening
 * it refreshes a stale mirror in the background) and may ask for a Refresh; Workspace admins
 * relink it to another repository or detach it into an ordinary project.
 */
export function projectRepoMirrorRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  // Read per request: building the app must not touch the envelope or the blob store.
  const mirror = () => mirrorDeps(deps);
  const guards = [
    requireTeam(deps),
    requireTeamPermission("team.read"),
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) =>
        c.json({ code: "too_large", message: "The request body is over 4 KiB." }, 413),
    }),
  ] as const;
  for (const path of ["/:id/repo", "/:id/repo/*"]) {
    for (const guard of guards) app.use(path, guard);
  }
  const viewer = (c: Ctx) => ({ teamId: c.get("team").id, userId: c.get("user").id });

  app.get("/:id/repo", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await readRepo(mirror(), viewer(c), id.data);
    return answer(c, out, (repo) => c.json({ repo }));
  });

  app.post("/:id/repo/refresh", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await refreshRepo(mirror(), viewer(c), id.data);
    return answer(c, out, (repo) => c.json({ repo }, 202));
  });

  app.post("/:id/repo/relink", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const body = await parseBody(c, gitRepoRelinkBodySchema);
    if (!body) {
      return invalidRequest(c, "Send connection_id and repository (the repository's name).");
    }
    const out = await relinkRepo(mirror(), viewer(c), id.data, body);
    return answer(c, out, (repo) => c.json({ repo }));
  });

  app.post("/:id/repo/detach", async (c) => {
    const id = param(c, "id", z.uuid());
    if (!id.success) return notFound(c);
    const out = await detachRepo(mirror(), viewer(c), id.data);
    return answer(c, out, (value) => c.json(value));
  });

  return app;
}
