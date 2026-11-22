import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import { getConnector } from "../../connectors/registry.js";
import {
  approveConnectorTools,
  approveSchema,
  reviewConnectorTools,
} from "../../connectors/reapproval.js";
import { nextPinnedBy } from "../../connectors/probe-credential.js";
import { removeSiteKey, setSiteKey } from "../../connectors/site-key.js";
import { putGrantSchema } from "../../connectors/grants.js";
import { listTeamsUsing } from "../../connectors/team-usage.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { idSchema, notFound, pinBody, type ConnectorKit } from "./shared.js";

/** A connector's site key, its tool approvals and the teams that enabled it. */
export function connectorAccessRoutes(kit: ConnectorKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { deps, db, pinAs } = kit;

  app.put("/:id/site-key", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const body = await parseBody(c, putGrantSchema);
    if (!body) {
      return invalidRequest(c, "Send the API key as api_key (8 to 2048 visible characters).");
    }
    if (!deps.envelope) {
      return c.json(
        { code: "credentials_unavailable", message: "This site cannot store credentials yet." },
        503,
      );
    }
    const result = await setSiteKey(db, deps.envelope, id.data, body.api_key, c.get("user").id);
    if (!result.ok) {
      return result.failure === "not_found"
        ? notFound(c)
        : c.json(
            {
              code: "not_site_key",
              message: "Choose 'Site-wide key' for this API-key connector first.",
            },
            409,
          );
    }
    const pin = await pinAs(c, id.data);
    const connector = await getConnector(db, id.data);
    const shown =
      pin && !(!pin.ok && pin.failure === "already_pinned") ? { pin: pinBody(pin, connector) } : {};
    return c.json({ connector, replaced: result.replaced, ...shown });
  });

  app.delete("/:id/site-key", async (c) => {
    const id = param(c, "id", idSchema);
    const removed = id.success ? await removeSiteKey(db, id.data) : undefined;
    if (removed === undefined) return notFound(c);
    return removed
      ? c.body(null, 204)
      : c.json({ code: "not_found", message: "No site-wide key is set." }, 404);
  });

  // What each tool is now: approved vs live definition, for the re-approval review (KOBE-102).
  app.get("/:id/tools", async (c) => {
    const id = param(c, "id", idSchema);
    const tools = id.success ? await reviewConnectorTools(db, id.data) : undefined;
    return tools ? c.json({ tools }) : notFound(c);
  });

  // Re-approve drifted tools, each with the hash of the live definition that was reviewed.
  app.post("/:id/tools/approve", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const input = await parseBody(c, approveSchema);
    if (!input) {
      return invalidRequest(c, "Send tools: a list of { name, sha256 } of the reviewed tools.");
    }
    const pinnedBy = await nextPinnedBy(
      db,
      deps.envelope,
      id.data,
      c.get("user").id,
      deps.mcp.oauthRefresh,
    );
    const result = await approveConnectorTools(db, id.data, input, pinnedBy);
    if (result.ok) return c.json({ approved: result.approved });
    if (result.error === "not_found") return notFound(c);
    return c.json(
      result.error === "stale"
        ? {
            code: "stale",
            tool: result.tool,
            message: "That tool changed again since you reviewed it. Review it again.",
          }
        : {
            code: "not_pending",
            tool: result.tool,
            message: "That tool is not waiting for approval.",
          },
      409,
    );
  });

  // The teams that enabled it, with their exposure (KOBE-641 detail panel). Read-only.
  app.get("/:id/teams", async (c) => {
    const id = param(c, "id", idSchema);
    const teams = id.success ? await listTeamsUsing(db, id.data) : undefined;
    return teams ? c.json({ teams }) : notFound(c);
  });

  return app;
}
