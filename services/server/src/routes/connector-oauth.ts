import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { kobeOrigin } from "../connectors/oauth/client.js";
import {
  finishFlow,
  startFlow,
  type OauthFlowDeps,
  type ReturnTarget,
} from "../connectors/oauth/flow.js";
import { DEFAULT_TIMEOUT_MS } from "../connectors/oauth/http.js";
import type { ServerDeps } from "../deps.js";
import { siteRoleAllows } from "../authz/permissions.js";
import { invalidRequest, notFound, param, parseBody } from "../http/request.js";
import { hitRateLimit, type RateLimitRule } from "../rate-limit.js";

/** Connect attempts per member (KOBE-784, P2-31): each one calls the authorization server. */
export const OAUTH_START_RATE: RateLimitRule = { windowMs: 10 * 60_000, max: 30 };

const idSchema = z.uuid();
/** `{return_to}` names where the browser comes back to (KOBE-835); no body is the same as `{}`. */
export const oauthStartBodySchema = z.strictObject({
  return_to: z.enum(["me", "site"]).optional(),
});
const startSchema = z.union([z.null(), oauthStartBodySchema]);
/** The fixed page per return target, on Kobe's own origin (never taken from the request). */
const RETURN_PATHS: Readonly<Record<ReturnTarget, string>> = {
  me: "/me/connectors",
  site: "/admin/site/connectors",
};
const MESSAGES = {
  oauth_unsupported: "This connector's authorization server cannot be used safely with Kobe.",
  oauth_unreachable: "Could not reach the connector's authorization server.",
  registration_failed: "The authorization server did not accept Kobe as a client.",
} as const;

function flowDeps(deps: ServerDeps): OauthFlowDeps | undefined {
  if (!deps.envelope) return undefined;
  return {
    db: deps.database.db,
    envelope: deps.envelope,
    io: { policy: deps.connectorUrlPolicy, timeoutMs: DEFAULT_TIMEOUT_MS },
    kobe: kobeOrigin(deps.publicUrl),
    now: () => new Date(),
  };
}

/**
 * Per-user OAuth connect flow (KOBE-109).
 *
 * POST /{connector_id}/oauth/start `{return_to?: "me" | "site"}` → 200 `{authorization_url}`: send
 *   the browser there. 400 for any other body; 404 not enabled; 422 `not_oauth` /
 *   `oauth_unsupported` / `registration_failed`; 429 `rate_limited` (`OAUTH_START_RATE` per
 *   member); 502 `oauth_unreachable`; 503 when the site has no envelope key. `site` (KOBE-835)
 *   brings a site admin back to the Site console's connector registry; anyone else goes to My
 *   connectors.
 * GET /oauth/callback?code&state&iss → 303 to `/me/connectors` (or `/admin/site/connectors`)
 *   `?connector_oauth=connected|failed&connector=<id>` (`reason`, a fixed code, on failure; the
 *   authorization server's own error text is never passed on). A state that does not open for
 *   this user and team is a 400 `invalid_state` and reveals nothing else.
 */
export function connectorOauthRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post("/:connectorId/oauth/start", async (c) => {
    const id = param(c, "connectorId", idSchema);
    if (!id.success) return notFound(c, "connector_not_available", "Not found.");
    const body = await parseBody(c, startSchema);
    if (body === undefined) return invalidRequest(c, 'Send nothing, or return_to "me" or "site".');
    const returnTo: ReturnTarget =
      body?.return_to === "site" && siteRoleAllows(c.get("siteRole"), "site.connectors.manage")
        ? "site"
        : "me";
    if (
      !(await hitRateLimit(deps.database.db, `oauth-start:${c.get("user").id}`, OAUTH_START_RATE))
    ) {
      return c.json(
        {
          code: "rate_limited",
          message: "Too many connection attempts. Try again in a few minutes.",
        },
        429,
      );
    }
    const flow = flowDeps(deps);
    if (!flow) {
      return c.json(
        { code: "credentials_unavailable", message: "This site cannot store credentials yet." },
        503,
      );
    }
    const result = await startFlow(
      flow,
      { teamId: c.get("team").id, userId: c.get("user").id, connectorId: id.data },
      returnTo,
    );
    if (result.ok) return c.json({ authorization_url: result.authorizationUrl });
    if (result.failure === "not_available") {
      return c.json(
        {
          code: "connector_not_available",
          message: "That connector is not enabled for your team.",
        },
        404,
      );
    }
    if (result.failure === "not_oauth") {
      return c.json({ code: "not_oauth", message: "That connector does not use OAuth." }, 422);
    }
    const status = result.failure === "oauth_unreachable" ? 502 : 422;
    const message = MESSAGES[result.failure as keyof typeof MESSAGES] ?? MESSAGES.oauth_unsupported;
    return c.json({ code: result.failure, message }, status);
  });

  app.get("/oauth/callback", async (c) => {
    const flow = flowDeps(deps);
    const state = c.req.query("state");
    if (!flow || !state) return c.json({ code: "invalid_state", message: "Invalid state." }, 400);
    const result = await finishFlow(
      flow,
      { userId: c.get("user").id, activeTeamId: c.get("team").id },
      {
        state,
        code: c.req.query("code"),
        iss: c.req.query("iss"),
        error: c.req.query("error"),
      },
    );
    if (!result.ok && result.connectorId === undefined) {
      return c.json({ code: "invalid_state", message: "Invalid state." }, 400);
    }
    const target = new URL(RETURN_PATHS[result.returnTo ?? "me"], deps.publicUrl);
    target.searchParams.set("connector_oauth", result.ok ? "connected" : "failed");
    if (result.connectorId !== undefined) target.searchParams.set("connector", result.connectorId);
    if (!result.ok) target.searchParams.set("reason", result.failure);
    return c.redirect(target.toString(), 303);
  });

  return app;
}
