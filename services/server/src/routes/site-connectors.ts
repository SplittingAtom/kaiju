import { connectorAccessRoutes } from "./site-connectors/access.js";
import { connectorCoreRoutes } from "./site-connectors/core.js";
import { connectorTemplateRoutes } from "./site-connectors/templates.js";
import { connectorKit, idSchema, notFound } from "./site-connectors/shared.js";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import { removeConnector } from "../connectors/registry.js";
import type { ServerDeps } from "../deps.js";
import { param } from "../http/request.js";

/**
 * The site connector registry (`/v1/site/connectors`, spec D6, D27; KOBE-100): install
 * Owner/Admins register MCP servers. URLs must pass the address policy the MCP proxy enforces at
 * connect time. Every change is audited without the URL (it may carry a key).
 */
export function siteConnectorsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.connectors.manage"));
  // The groups mount in their original order, after the Site permission check.
  const kit = connectorKit(deps);
  app.route("/", connectorCoreRoutes(kit));
  app.route("/", connectorAccessRoutes(kit));
  app.route("/", connectorTemplateRoutes(kit));

  app.delete("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    const result = id.success ? await removeConnector(db, id.data) : undefined;
    if (!result) return notFound(c);
    const message =
      result.teams > 0
        ? `Removed from the registry. ${result.teams} team${result.teams === 1 ? "" : "s"} had it enabled, so it is kept disabled: it is offered to no team and its calls are refused.`
        : "Removed from the registry. It is kept disabled and its name stays reserved.";
    return c.json({ ...result, message });
  });

  return app;
}
