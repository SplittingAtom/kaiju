import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, param, parseBody } from "../http/request.js";
import type { RebuildOutcome, RebuildStatus } from "../sandbox-lifecycle/rebuild.js";
import { idSchema } from "../teams/schemas.js";
import { logger } from "../logger.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";

/**
 * Rebuild a workspace whose volume was lost with its node (KOBE-739; `sandbox-lifecycle/rebuild.ts`).
 * Member-confirmed: `GET` says whether the volume is lost and when the workspace last synced (the
 * member reads what will be lost), `POST {confirm: true}` rebuilds it. The member does it at
 * `/v1/workspace/rebuild`; a team admin (`team.members.manage`) for a member at
 * `/v1/team/workspaces/{userId}/rebuild`. Both are audited (`sandbox.volume_rebuilt`).
 */

const confirmSchema = z.strictObject({ confirm: z.literal(true) });

/** Status reads per caller: a burst of 20, then one every 5 s (each may read the cluster). */
export const STATUS_RATE = { capacity: 20, refillPerSecond: 0.2 } as const;

/** 429 when the caller read the status too often (the answer is cached 30 s anyway). */
function throttled(c: Ctx, limiter: RateLimiter, key: string) {
  const wait = limiter.take(key);
  if (wait <= 0) return undefined;
  c.header("Retry-After", String(Math.ceil(wait / 1000)));
  return c.json(
    {
      code: "rate_limited",
      message: "Too many requests. Try again shortly.",
      retry_after_ms: wait,
    },
    429,
  );
}

type Ctx = Context<{ Variables: TeamVariables }>;

const unavailable = (c: Ctx) =>
  c.json(
    {
      code: "rebuild_unavailable",
      message:
        "Workspaces can't be rebuilt on this server: it has no workspace storage to restore from.",
    },
    503,
  );

const statusBody = (s: RebuildStatus) => ({
  volume: s.volume,
  last_synced_at: s.lastSyncedAt?.toISOString() ?? null,
  rebuildable: s.rebuildable,
  ...(s.downSince ? { down_since: s.downSince.toISOString() } : {}),
  ...(s.offerAt ? { offer_at: s.offerAt.toISOString() } : {}),
});

/**
 * Runs the rebuild. A failure before the confirm committed changed nothing; one after it is
 * finished by the next confirm or the sweep. The answer says only what is true in both cases.
 */
async function confirmRebuild(c: Ctx, run: () => Promise<RebuildOutcome>) {
  try {
    return answer(c, await run());
  } catch (err) {
    logger.error({ err, team_id: c.get("team").id }, "workspace rebuild failed");
    return c.json(
      {
        code: "rebuild_failed",
        message:
          "The sandbox couldn't be rebuilt right now. If the rebuild had already started, Kobe finishes it on its own; otherwise nothing was changed. Try again in a moment.",
      },
      503,
    );
  }
}

function answer(c: Ctx, outcome: RebuildOutcome) {
  switch (outcome.kind) {
    case "rebuilt":
      return c.json({
        status: "rebuilt",
        last_synced_at: outcome.lastSyncedAt?.toISOString() ?? null,
      });
    case "already":
      return c.json({ status: "already", last_synced_at: null });
    case "superseded":
      return c.json(
        {
          code: "rebuild_superseded",
          message:
            "This sandbox was already rebuilt or replaced since the rebuild was confirmed, so nothing was deleted. Reload to see its current state.",
        },
        409,
      );
    case "pending":
      return c.json(
        {
          code: "rebuild_pending",
          message:
            "The rebuild is confirmed, but the old storage couldn't be removed yet. Kobe keeps trying on its own; send your message again in a few minutes.",
        },
        503,
      );
    case "not_yet":
      return c.json(
        {
          code: "volume_not_yet_lost",
          message:
            "The server that holds this sandbox's storage is down, but not for long enough to rebuild it: it may still come back with the files. Try again later.",
          offer_at: outcome.offerAt.toISOString(),
        },
        409,
      );
    case "reachable":
      return c.json(
        {
          code: "volume_reachable",
          message:
            "This workspace's storage isn't lost, so there is nothing to rebuild. If it still doesn't start, ask your site admin.",
        },
        409,
      );
    case "offboarded":
      return c.json(
        {
          code: "workspace_offboarded",
          message: "This workspace belongs to a departed member and can't be rebuilt.",
        },
        409,
      );
    case "no_workspace":
      return c.json({ code: "no_workspace", message: "There is no workspace to rebuild." }, 404);
  }
}

/** `/v1/workspace/rebuild`: the signed-in member's own workspace in the active team. */
export function workspaceRebuildRoutes(
  deps: ServerDeps,
  limiter: RateLimiter = createRateLimiter(STATUS_RATE),
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/", async (c) => {
    const rebuild = deps.workspaceRebuild;
    const limited = throttled(c, limiter, c.get("user").id);
    if (limited) return limited;
    if (!rebuild.available()) return unavailable(c);
    return c.json(statusBody(await rebuild.status(c.get("team"), c.get("user").id)));
  });

  app.post("/", async (c) => {
    const rebuild = deps.workspaceRebuild;
    if (!(await parseBody(c, confirmSchema))) {
      return invalidRequest(c, "Send {confirm: true} to rebuild the workspace.");
    }
    if (!rebuild.available()) return unavailable(c);
    return confirmRebuild(c, () => rebuild.rebuild(c.get("team"), c.get("user").id, false));
  });

  return app;
}

/** `/v1/team/workspaces/{userId}/rebuild`: a team admin for one member of the active team. */
export function teamWorkspaceRebuildRoutes(
  deps: ServerDeps,
  limiter: RateLimiter = createRateLimiter(STATUS_RATE),
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.members.manage"));

  app.get("/:userId/rebuild", async (c) => {
    const rebuild = deps.workspaceRebuild;
    const userId = param(c, "userId", idSchema);
    if (!userId.success) return invalidRequest(c);
    const limited = throttled(c, limiter, c.get("user").id);
    if (limited) return limited;
    if (!rebuild.available()) return unavailable(c);
    return c.json(statusBody(await rebuild.status(c.get("team"), userId.data)));
  });

  app.post("/:userId/rebuild", async (c) => {
    const rebuild = deps.workspaceRebuild;
    const userId = param(c, "userId", idSchema);
    if (!userId.success) return invalidRequest(c);
    if (!(await parseBody(c, confirmSchema))) {
      return invalidRequest(c, "Send {confirm: true} to rebuild the workspace.");
    }
    if (!rebuild.available()) return unavailable(c);
    return confirmRebuild(c, () => rebuild.rebuild(c.get("team"), userId.data, true));
  });

  return app;
}
