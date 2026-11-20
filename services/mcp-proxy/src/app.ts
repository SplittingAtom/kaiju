import { Hono } from "hono";
import { honoTracing } from "@kobe/telemetry";
import { mcpRoutes, type McpRouteDeps } from "./mcp.js";
import { appCallRoutes, type AppCallDeps } from "./app-calls.js";
import { logger } from "./logger.js";
import { probeRoutes, type ProbeDeps } from "./probe.js";

const SERVICE = "mcp-proxy";

function base(): Hono {
  const app = new Hono();
  app.use("*", honoTracing({ joinCallerTrace: false }));
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => c.json({ status: "ready", service: SERVICE }));
  return app;
}

/**
 * The sandbox-facing listener: health endpoints, and the MCP endpoint when dependencies are
 * provided. Nothing under `/internal` is served here (KOBE-693): the server's routes have their
 * own listener ({@link createInternalApp}), which the NetworkPolicy opens to server pods only.
 */
export function createApp(deps?: McpRouteDeps): Hono {
  const app = base();
  if (deps) app.route("/v1/mcp", mcpRoutes(deps));
  app.onError((err, c) => {
    deps?.log.error({ err }, "unhandled error");
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error." } },
      500,
    );
  });
  return app;
}

/**
 * The server-facing listener (KOBE-693): the pinning probe (KOBE-101) and MCP Apps' own calls
 * (KOBE-436), each keyed with the server's routes key and held to the connector's registered URL.
 */
export function createInternalApp(probe?: ProbeDeps, appCalls?: AppCallDeps): Hono {
  const app = base();
  if (probe) app.route("/internal/v1/probe", probeRoutes(probe));
  if (appCalls) app.route("/internal/v1/app-calls", appCallRoutes(appCalls));
  app.onError((err, c) => {
    logger.error({ err }, "unhandled error (internal routes)");
    return c.json({ code: "internal_error" }, 500);
  });
  return app;
}
