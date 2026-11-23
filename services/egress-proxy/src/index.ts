import {
  createDb,
  headerBox,
  isActiveTeamMember,
  loadTeamEgress,
  loadTeamEgressHeaders,
  openHeaders,
} from "@kobe/db";
import { initTelemetry, loadTelemetryConfig } from "@kobe/telemetry";
import { AddressPolicy } from "./address-policy.js";
import { AllowlistCache } from "./allowlist.js";
import { egressTokenVerifier, siteTokenVerifier } from "./auth.js";
import { BlockedReporter, dbBlockedSink } from "./blocked-reporter.js";
import { loadEgressCeilingWithInternal } from "./ceiling-store.js";
import { ChangeListener } from "./change-listener.js";
import { loadConfig } from "./config.js";
import { ConnectionAudit, dbAuditWriter } from "./connection-audit.js";
import { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import { logger } from "./logger.js";
import { PreAuthGate } from "./preauth-gate.js";
import { TunnelRegistry } from "./tunnel-registry.js";
import { createEgressProxy } from "./proxy.js";
import { dnsResolver } from "./resolver.js";
import { GitDecisionCache, serverDecider } from "./git/decisions.js";
import { RateBuckets } from "./rate-buckets.js";

/** Open tunnels get this long to finish on shutdown; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 20_000;

const config = loadConfig(process.env);
const telemetry = initTelemetry(loadTelemetryConfig(process.env, "egress-proxy"));
const database = createDb(config.databaseUrl, {
  max: config.dbPoolMax,
  applicationName: "kobe-egress-proxy",
});
const db = database.db;

const cache = new AllowlistCache(
  {
    loadCeiling: () => loadEgressCeilingWithInternal(db),
    loadTeam: (teamId) => loadTeamEgress(db, teamId),
    isActiveMember: (teamId, userId) => isActiveTeamMember(db, teamId, userId),
    loadTeamHeaders: (teamId) => loadTeamEgressHeaders(db, teamId),
  },
  { ttlMs: config.cacheTtlMs, degradedTtlMs: 5_000, memberTtlMs: 30_000, maxEntries: 10_000 },
);
// Git smart-HTTP for connected organizations (KOBE-763): the server decides and mints.
const gitDecisions = config.git
  ? new GitDecisionCache(
      serverDecider({
        serverUrl: config.git.serverUrl,
        internalKey: config.git.internalKey,
        timeoutMs: config.git.decisionTimeoutMs,
      }),
      { maxEntries: 2_000 },
    )
  : undefined;
const tunnels = new TunnelRegistry(cache, logger);
tunnels.start(config.recheckMs);
const listener = new ChangeListener({
  connectionString: config.databaseUrl,
  cache,
  logger,
  // Revocation reaches open tunnels: re-check the affected ones on every hint.
  onChange: (scope) => {
    void tunnels.recheck(scope);
    // Git decisions (KOBE-763) carry membership: any hint drops them (they live 30 s anyway).
    gitDecisions?.clear();
  },
});
listener.start();
const audit = new ConnectionAudit({
  write: dbAuditWriter(db),
  logger,
  flushMs: config.auditFlushMs,
});
audit.start();
const blocked = new BlockedReporter({ sink: dbBlockedSink(db), logger });
// Header injection (KOBE-39): only with the header secret; plain HTTP is refused otherwise.
const box = config.headerSecrets ? headerBox(config.headerSecrets) : undefined;

let draining = false;
const preauth = new PreAuthGate({ perSource: config.preAuthPerSource, total: config.preAuthTotal });
setInterval(() => {
  const refused = preauth.drainRefused();
  if (refused > 0)
    logger.warn({ refused }, "egress proxy refused unauthenticated sockets over the limit");
}, 60_000).unref();
const server = createEgressProxy({
  verify: egressTokenVerifier(config.sessionVerifyKeys),
  // The server's site jobs (KOBE-343: the catalog's git mirror), with the same key.
  verifySite: siteTokenVerifier(config.sessionVerifyKeys),
  policy: cache,
  resolve: dnsResolver({ timeoutMs: config.dnsTimeoutMs }),
  addresses: new AddressPolicy({
    allowedInternal: config.allowedInternalCidrs,
    internalTargets: config.internalTargets,
    extraDenied: config.deniedCidrs,
  }),
  connections: new ConnectionLimits({
    perSandbox: config.maxConnectionsPerSandbox,
    total: config.maxConnections,
  }),
  bandwidth: new BandwidthLimiter(config.bandwidthBytesPerSecond),
  audit,
  blocked,
  logger,
  settings: {
    allowedPorts: config.allowedPorts,
    idleTimeoutMs: config.idleTimeoutMs,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    preAuthTimeoutMs: config.preAuthTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    maxTunnelMs: config.maxTunnelMs,
  },
  preauth,
  tunnels,
  ready: () => !draining,
  ...(config.git && gitDecisions
    ? {
        git: {
          decisions: gitDecisions,
          settings: {
            maxFetchRequestBytes: config.git.maxFetchRequestBytes,
            maxResponseBytes: config.git.maxResponseBytes,
            timeoutMs: config.git.timeoutMs,
          },
          concurrency: new ConnectionLimits({
            perSandbox: config.git.concurrentPerSandbox,
            total: config.maxConnections,
          }),
          rate: new RateBuckets({
            burst: config.git.requestBurst,
            perSecond: config.git.requestsPerSecond,
          }),
          lookups: new RateBuckets({
            burst: config.git.lookupsPerMinute,
            perSecond: config.git.lookupsPerMinute / 60,
          }),
          recordEvent: (event) => audit.recordEvent(event),
        },
      }
    : {}),
  ...(box
    ? {
        headers: {
          open: (teamId: string, pattern: string, sealed: string) =>
            openHeaders(box, teamId, pattern, sealed),
        },
        upgrade: config.upgrade,
      }
    : {}),
});
// Tunnels and unauthenticated sockets have separate budgets (the gate enforces the latter), so a
// flood of unauthenticated sockets never takes capacity from other sandboxes' tunnels.
server.maxConnections = config.maxConnections + config.preAuthTotal;
server.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      allowedPorts: config.allowedPorts,
      allowedInternalCidrs: config.allowedInternalCidrs.length,
      internalTargets: config.internalTargets.length,
      headerInjection: box !== undefined,
      git: config.git !== undefined,
    },
    "egress proxy listening",
  );
});

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => server.closeAllConnections(), DRAIN_TIMEOUT_MS);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  tunnels.stop();
  gitDecisions?.clear();
  await audit.stop();
  await blocked.drain();
  await listener.close();
  await database.close();
  await telemetry.shutdown();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, "shutdown error");
      process.exit(1);
    });
  });
}
