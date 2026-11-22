import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, param, parseBody } from "../http/request.js";
import type { RebuildOutcome, RebuildStatus } from "../sandbox-lifecycle/rebuild.js";
import { idSchema } from "../teams/schemas.js";
import { logger } from "../logger.js";

/**
 * Rebuild a workspace whose volume was lost with its node (KOBE-739; `sandbox-lifecycle/rebuild.ts`).
 * Member-confirmed: `GET` says whether the volume is lost and when the workspace last synced (the
 * member reads what will be lost), `POST {confirm: true}` rebuilds it. The member does it at
 * `/v1/workspace/rebuild`; a team admin (`team.members.manage`) for a member at
 * `/v1/team/workspaces/{userId}/rebuild`. Both are audited (`sandbox.volume_rebuilt`).
 */

const confirmSchema = z.strictObject({ confirm: z.literal(true) });

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
});

/** Runs the rebuild; a Kubernetes or lock failure rolled everything back: retryable. */
async function confirmRebuild(c: Ctx, run: () => Promise<RebuildOutcome>) {
  try {
    return answer(c, await run());
  } catch (err) {
    logger.error({ err, team_id: c.get("team").id }, "workspace rebuild failed; nothing changed");
    return c.json(
      {
        code: "rebuild_failed",
        message: "The workspace couldn't be rebuilt right now. Nothing was changed; try again.",
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
export function workspaceRebuildRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/", async (c) => {
    const rebuild = deps.workspaceRebuild;
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
export function teamWorkspaceRebuildRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.members.manage"));

  app.get("/:userId/rebuild", async (c) => {
    const rebuild = deps.workspaceRebuild;
    const userId = param(c, "userId", idSchema);
    if (!userId.success) return invalidRequest(c);
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
