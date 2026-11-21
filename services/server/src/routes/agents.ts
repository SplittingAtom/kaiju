import { agentListRoutes } from "./agents/lists.js";
import { agentCollectionRoutes } from "./agents/collection.js";
import { agentDefinitionRoutes } from "./agents/definitions.js";
import { agentLifecycleRoutes } from "./agents/lifecycle.js";
import { actorOf, agentKit, locationFor, mayDangerous, type Ctx } from "./agents/shared.js";
import { Hono, type Context } from "hono";
import { agentAccess } from "../agents/access.js";
import { mountEvalRoutes } from "../agents/eval/routes.js";
import type { EvalRunner } from "../agents/eval/service.js";
import { mountFeedbackTotals } from "../agents/feedback-routes.js";
import { mountAgentEvalCases } from "../eval-cases/routes.js";
import { mountOrbitExport } from "../agents/orbit/routes.js";
import { mountVersionRoutes } from "../agents/version-routes.js";
import { ROSTER_READ_ACCESS } from "../agents/roster-read.js";
import { mountAgentRosterRoutes } from "./agent-roster.js";
import { mountAgentTransferRoutes } from "./agent-transfer.js";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

/**
 * Agent definitions from the active team's point of view (spec D19, §6.1 `CRUD /v1/agents`):
 * the team's agents, the caller's personal agents, and the read-only gallery. POST and PUT take
 * JSON or an agent markdown file (import); `GET /:id/export` downloads the file. Versions,
 * publish, rollback and unarchive (KOBE-46) are `agents/version-routes.ts`. Gallery curation is
 * `/v1/site/gallery/agents`.
 */
export function agentRoutes(
  deps: ServerDeps,
  evalOptions: { readonly runner?: EvalRunner } = {},
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  const kit = agentKit(deps);
  const { visible, rosterRead } = kit;

  app.route("/", agentListRoutes(kit));

  // Rosters (KOBE-566): `/roster` before "/:id"; assignments under "/:id/assignments".
  mountAgentRosterRoutes(app, deps);
  // Transfers (KOBE-568): `/transfers` before "/:id"; offers under "/:id/transfer".
  mountAgentTransferRoutes(app, deps);

  app.route("/", agentCollectionRoutes(kit));
  app.route("/", agentDefinitionRoutes(kit));
  app.route("/", agentLifecycleRoutes(kit));

  const resolveVersioned = async (raw: Context) => {
    const c = raw as Ctx;
    const agent = await visible(c);
    if (!agent) return null;
    return {
      agent,
      location: locationFor(c, agent.scope),
      access: agentAccess(actorOf(c), agent),
    };
  };
  const resolveReadable = async (raw: Context) => {
    const found = await resolveVersioned(raw);
    if (found) return found;
    const read = await rosterRead(raw as Ctx);
    return read ? { agent: read.agent, location: read.location, access: ROSTER_READ_ACCESS } : null;
  };
  mountVersionRoutes(app, {
    db,
    limits: deps.agentLimits,
    resolve: resolveVersioned,
    resolveRead: resolveReadable,
    userId: (c) => (c as Ctx).get("user").id,
    mayUseDangerousMode: (c) => mayDangerous(c as Ctx),
    evals: {
      runner: evalOptions.runner,
      // A getter: read-only requests never touch deps.background (threads.db.test.ts checks).
      get background() {
        return deps.background;
      },
      team: (c) => ({ id: (c as Ctx).get("team").id, slug: (c as Ctx).get("team").slug }),
    },
  });
  mountEvalRoutes(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
  });
  mountOrbitExport(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
  });
  // Answer ratings per version (KOBE-275): owners and team admins.
  mountFeedbackTotals(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
    role: (c) => (c as Ctx).get("team").role,
    userId: (c) => (c as Ctx).get("user").id,
  });
  // Shared eval cases (KOBE-276): the agent's owner only.
  mountAgentEvalCases(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
    userId: (c) => (c as Ctx).get("user").id,
  });

  return app;
}
