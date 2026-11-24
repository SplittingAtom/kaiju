import { serve } from "@hono/node-server";
import { initTelemetry, loadTelemetryConfig } from "@kaiju/telemetry";
import { createApp, createInternalApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServerCredentials } from "./credentials.js";
import { createLimiter } from "./limits.js";
import { logger } from "./logger.js";
import { createRegisteredUrlLookup } from "./registered-url.js";
import { createPolicyServer } from "./server-client.js";
import { createUpstreamClient } from "./upstream.js";

/** Open streams get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const telemetry = initTelemetry(loadTelemetryConfig(process.env, "mcp-proxy"));
const upstream = createUpstreamClient({
  policy: config.upstream,
  maxResponseBytes: config.limits.maxResponseBytes,
});
const policyServer = createPolicyServer({
  baseUrl: config.serverUrl,
  internalKey: config.internalKey,
  timeoutMs: config.limits.serverTimeoutMs,
  grantTimeoutMs: config.limits.grantTimeoutMs,
  onError: (err) => logger.warn({ err }, "policy server unavailable (call refused)"),
});
const app = createApp({
  sessionVerifyKeys: config.sessionVerifyKeys,
  server: policyServer,
  upstream,
  // Per-user API-key and OAuth grants from the server (KOBE-108, KOBE-109).
  credentials: createServerCredentials(policyServer),
  limiter: createLimiter({
    burst: config.limits.requestBurst,
    perSecond: config.limits.requestsPerSecond,
    callsPerSandbox: config.limits.callsPerSandbox,
    maxConcurrentCalls: config.limits.maxConcurrentCalls,
  }),
  limits: config.limits,
  log: logger,
});
// The server's routes (KOBE-693): their own port, admitted from server pods only, keyed with the
// routes key, and held to each connector's registered URL.
const registeredUrl = createRegisteredUrlLookup({
  baseUrl: config.serverUrl,
  internalKey: config.internalKey,
  timeoutMs: config.limits.serverTimeoutMs,
});
const internalApp = createInternalApp(
  {
    internalKey: config.routesKey,
    upstream,
    timeoutMs: config.limits.upstreamTimeoutMs,
    maxRequestBytes: 4 * 1024,
    registeredUrl,
  },
  // MCP Apps' own calls (KOBE-436), decided and audited by the server first.
  {
    internalKey: config.routesKey,
    upstream,
    timeoutMs: config.limits.upstreamTimeoutMs,
    registeredUrl,
  },
);
if (config.routesKeyShared) {
  logger.warn(
    "KOBE_MCP_ROUTES_KEY is not set: the internal key also authenticates the server's calls (add a routes-key to the internal key Secret)",
  );
}
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    {
      port: info.port,
      insecureHttp: config.upstream.allowInsecureHttp,
      ports: config.upstream.allowedPorts,
    },
    "listening",
  );
});
const internalServer = serve({ fetch: internalApp.fetch, port: config.internalPort }, (info) =>
  logger.info({ port: info.port }, "internal listener"),
);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  internalServer.close();
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void Promise.all([upstream.close(), telemetry.shutdown()]).finally(() =>
      process.exit(err ? 1 : 0),
    );
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  if ("closeIdleConnections" in internalServer) internalServer.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    if ("closeAllConnections" in internalServer) internalServer.closeAllConnections();
    setTimeout(() => process.exit(1), 1_000).unref();
  }, DRAIN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
