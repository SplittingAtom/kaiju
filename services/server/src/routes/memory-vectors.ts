import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  requestNamesTeam,
  requireSitePermission,
  requireTeam,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { gatewayProviderNames } from "../memory/embeddings/model.js";
import { buildRunningElsewhere } from "../memory/embeddings/backfill.js";
import { readCoverage } from "../memory/embeddings/vector-store.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/**
 * The Workspace a Site admin acts in (the request's team, resolved and membership-checked by
 * `requireTeam`: the team header with the session's active team, or an admin tool's run team): it
 * pays for vectors they start (KOBE-409 billing). Null without one: each Workspace pays (KOBE-669).
 */
export async function adminWorkspace(deps: ServerDeps, c: Ctx): Promise<string | null> {
  if (!(await requestNamesTeam(deps, c))) return null;
  let teamId: string | null = null;
  await requireTeam(deps)(c, async () => {
    teamId = c.get("team").id;
  });
  return teamId;
}

/**
 * `/v1/memory/vectors` (KOBE-409, Site admins): what the Site memory page shows about vector
 * search, and its Build vectors / Re-embed action.
 *
 * - `GET /`: pgvector (`enabled`, `available` but not enabled, or `missing`), whether the columns
 *   exist, the Site embedding model and whether its provider is still on the gateway, the
 *   in-cluster model and the gateway providers to choose from, coverage (items with a vector of
 *   the current model, of all items that can have one), this replica's build job and whether
 *   another replica runs one (`running_elsewhere`).
 * - `POST /build`: starts the Site-wide job (202): paid by the admin in their active Workspace,
 *   or without one each Workspace by its own member (KOBE-669, `buildTargets`); or says why not
 *   (409 running, 400 unavailable). Its calls are in the usage records (`memory_embed`, payer and
 *   Workspace); the model choice itself is audited with the Site memory settings.
 */
export function memoryVectorRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", requireSitePermission("site.settings.manage") as MiddlewareHandler);

  app.get("/", async (c) => {
    const embeddings = deps.memoryEmbeddings;
    embeddings.invalidate();
    const [support, model, providers] = await Promise.all([
      embeddings.support(),
      embeddings.model(),
      gatewayProviderNames(db, embeddings.localModel),
    ]);
    const current = model.ok ? model.model : null;
    return c.json({
      pgvector: support.extension,
      columns: support.columns,
      model: current,
      model_state: model.ok ? "ok" : model.reason,
      server_calls: embeddings.client !== undefined,
      local_model: embeddings.localModel ?? null,
      providers: [...providers].sort(),
      coverage: support.columns ? await readCoverage(db, current) : null,
      job: deps.memoryVectors.job ?? null,
      running_elsewhere:
        deps.memoryVectors.job?.state !== "running" && (await buildRunningElsewhere(db)),
    });
  });

  app.post("/build", async (c) => {
    const teamId = await adminWorkspace(deps, c);
    const started = await deps.memoryVectors.start({ userId: c.get("user").id, teamId });
    if (!started.ok) {
      return c.json(
        { code: started.code, message: started.message },
        started.code === "running" ? 409 : 400,
      );
    }
    return c.json({ job: started.job }, 202);
  });

  return app;
}
