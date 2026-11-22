import { Hono } from "hono";
import { workspaceChangeRoutes } from "./routes/changes.js";
import { workspaceKit } from "./routes/kit.js";
import { workspaceReadRoutes } from "./routes/reads.js";
import { Busy, error, isTimeout, type Vars, type WorkspaceRoutesDeps } from "./routes/shared.js";
import { workspaceUploadRoutes } from "./routes/uploads.js";

export {
  WORKSPACE_DB_LIMITS,
  WORKSPACE_MAX_TRANSFERS,
  WORKSPACE_META_RATE,
  WORKSPACE_RATE,
  type WorkspaceDbLimits,
  type WorkspaceRoutesDeps,
} from "./routes/shared.js";

/**
 * The sandbox-facing workspace sync endpoints (contract: packages/protocol
 * sandbox-wire/workspace-sync.ts), mounted on the sandbox listener only. Everything is scoped to
 * the caller's verified (team, user); object keys never come from the request.
 */
export function workspaceRoutes(deps: WorkspaceRoutesDeps): Hono<Vars> {
  const kit = workspaceKit(deps);
  const { log, limiter, busy } = kit;
  const app = new Hono<Vars>();

  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    const auth = await deps.authenticate(c.req.header("authorization"));
    if (!auth.ok) {
      log.info({ reason: auth.reason }, "workspace sync request refused");
      return error(c, 401, "unauthorized", "Valid sandbox token required.");
    }
    const wait = limiter.take(auth.caller.sandboxId);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return error(c, 429, "rate_limited", "Too many requests.");
    }
    c.set("caller", auth.caller);
    await next();
  });

  // The groups mount in their original order, after the caller check.
  app.route("/", workspaceReadRoutes(kit));
  app.route("/", workspaceUploadRoutes(kit));
  app.route("/", workspaceChangeRoutes(kit));

  app.onError((err, c) => {
    if (err instanceof Busy) return busy(c, err.status, "Too much workspace work in flight.");
    if (isTimeout(err)) {
      c.header("Retry-After", "2");
      return error(c, 503, "retry_later", "The workspace is busy; retry.");
    }
    log.error({ err }, "workspace sync request failed");
    return error(c, 500, "internal", "Workspace sync failed; retry.");
  });

  return app;
}
