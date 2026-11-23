import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { signSiteEgressToken } from "@kobe/session-token";
import type { Logger } from "pino";
import { createApp, type AppOptions } from "../app.js";
import type { Config } from "../config.js";
import type { ServerDeps } from "../deps.js";
import { createInternalApp } from "../routes/internal.js";
import { createSandboxApp } from "../routes/sandbox.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import { providerLiveness, sandboxWireVerifier } from "../sandbox-wire/provider-auth.js";
import { skillEvalFixtureRoutes } from "../skills/evals/fixture-routes.js";
import { egressProxyUrl } from "../skills/mirror/config.js";
import { mirrorHttpClient } from "../skills/mirror/http-client.js";
import { IMPORT_FETCH_MAX_BYTES } from "../skills/import/service.js";
import { skillSandboxRoutes } from "../skills/sandbox-routes.js";
import { createSandboxAuthenticator, type WorkspaceSync } from "../workspace-sync/index.js";
import { DRAIN_TIMEOUT_MS } from "./process-jobs.js";

type NodeServer = ReturnType<typeof serve>;

export interface ListenersInput {
  readonly config: Config;
  readonly log: Logger;
  readonly deps: ServerDeps | undefined;
  readonly sandbox: SandboxRuntime | undefined;
  readonly workspaceSync: WorkspaceSync | undefined;
  /** The user-facing app's options besides the skill import (built from the sandbox here). */
  readonly app: AppOptions;
}

export interface Listeners {
  /** The user-facing port, once it listens. */
  readonly port: number;
  /** Closes every listener; resolves once the user-facing one has (rejects on its close error). */
  close(): Promise<void>;
}

/** Workspace sync's caller checks; revocations (deactivation, removal) clear its cache. */
function workspaceAuth(d: ServerDeps, s: SandboxRuntime, allowEval = false) {
  const authenticate = createSandboxAuthenticator({
    allowEval,
    db: d.database.db,
    verify: sandboxWireVerifier(s.sessionVerifyKeys),
    // Short positive cache: a destroyed or replaced sandbox loses access within 5 s.
    liveness: providerLiveness(s.provider, d.database.db, 5_000),
  });
  d.sandboxWire.onUserRevalidate((userId) => authenticate.forget(userId));
  return authenticate;
}

/** Governed skill import (KOBE-344): fetched through the egress proxy with a site token. */
function skillImport(sandbox: SandboxRuntime): NonNullable<AppOptions["skillImport"]> {
  return {
    http: (url: string, deadlineAt: number) =>
      mirrorHttpClient({
        deadlineAt,
        remote: url,
        credentials: null,
        proxy: {
          url: egressProxyUrl(sandbox.settings),
          token: () =>
            signSiteEgressToken("skill-import", sandbox.sessionKeys["kobe.egress-proxy"]),
        },
        maxResponseBytes: IMPORT_FETCH_MAX_BYTES,
      }),
  };
}

/**
 * Sandbox-facing listener: the only server port the sandbox NetworkPolicy allows (no user API).
 * Aborted at shutdown (`closing`) so held session long-polls (KOBE-417) answer at once.
 */
function sandboxListener(
  i: ListenersInput,
  deps: ServerDeps,
  sandbox: SandboxRuntime,
  closing: AbortSignal,
): NodeServer {
  // One caller check for every sandbox-listener HTTP endpoint (workspace sync, skill bundles).
  const sandboxAuth = workspaceAuth(deps, sandbox);
  // Skill bundles and eval fixtures also serve a skill eval's own sandbox (KOBE-325); workspace
  // sync never does.
  const evalCapableAuth = workspaceAuth(deps, sandbox, true);
  const blobs = deps.blobs;
  const routes = { db: deps.database.db, authenticate: evalCapableAuth, log: i.log };
  // Skill bundles (KOBE-82): served from the same object store, to live sandboxes only.
  const skillRoutes = blobs
    ? {
        skills: skillSandboxRoutes({ ...routes, blobs }),
        evalFixtures: skillEvalFixtureRoutes({ ...routes, blobs }),
      }
    : {};
  return serve(
    {
      fetch: createSandboxApp({
        ...sandbox,
        sessionTokenTtlSeconds: i.config.sessionTokenTtlSeconds,
        closing,
        ...(i.workspaceSync ? { workspace: i.workspaceSync.routes(sandboxAuth) } : {}),
        ...skillRoutes,
      }).fetch,
      port: sandbox.settings.endpoints.server.targetPort,
      // Workspace uploads (KOBE-27) may take a while: up to 1 GiB per file.
      serverOptions: { requestTimeout: 60 * 60_000 },
    },
    (info) => i.log.info({ port: info.port }, "sandbox listener"),
  );
}

/**
 * Internal listener (KOBE-58): the MCP proxy's policy re-check. Its own port, admitted by the
 * release NetworkPolicy from the MCP proxy only, and keyed (routes/internal.ts).
 */
function internalListener(
  i: ListenersInput,
  deps: ServerDeps,
  sandbox: SandboxRuntime,
  liveness: ReturnType<typeof providerLiveness>,
): NodeServer | undefined {
  const internalKey = i.config.mcpProxyInternalKey;
  if (!internalKey) {
    i.log.error(
      "KOBE_MCP_PROXY_INTERNAL_KEY is not set: MCP calls are refused (install with the chart)",
    );
    return undefined;
  }
  return serve(
    {
      fetch: createInternalApp({
        internalKey,
        mcp: deps.mcp,
        kobe: deps.kobeMcp,
        appResults: deps.appResults,
        auth: {
          db: deps.database.db,
          sessionVerifyKeys: sandbox.sessionVerifyKeys["kobe.mcp-proxy"],
          liveness,
        },
        ...(i.config.egressProxyInternalKey
          ? {
              git: {
                internalKey: i.config.egressProxyInternalKey,
                auth: {
                  db: deps.database.db,
                  sessionVerifyKeys: sandbox.sessionVerifyKeys["kobe.egress-proxy"],
                  liveness,
                  audience: "kobe.egress-proxy" as const,
                },
                transport: {
                  db: deps.database.db,
                  envelope: deps.envelope,
                  net: { policy: deps.connectorUrlPolicy },
                },
              },
            }
          : {}),
      }).fetch,
      port: i.config.internalPort,
    },
    (info) => i.log.info({ port: info.port }, "internal listener"),
  );
}

/** Closes the user-facing server: idle connections now, the rest after the drain timeout. */
function closeMain(server: NodeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Open streams (SSE) get the drain timeout to finish before being cut.
    const cut = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, DRAIN_TIMEOUT_MS);
    cut.unref();
    server.close((err) => {
      clearTimeout(cut);
      if (err) reject(err);
      else resolve();
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  });
}

/**
 * The process's listeners: the user-facing app (the scheduler serves health endpoints only),
 * and on a server replica with a sandbox runtime the sandbox listener (with the sandbox wire,
 * KOBE-24, never on the user-facing app) and the internal listener.
 */
export async function startListeners(i: ListenersInput): Promise<Listeners> {
  const { deps, sandbox, log, config } = i;
  const isServer = config.process === "server";
  const server = serve(
    {
      fetch: createApp(isServer ? deps : undefined, {
        ...i.app,
        ...(sandbox ? { skillImport: skillImport(sandbox) } : {}),
      }).fetch,
      port: config.port,
    },
    (info) => log.info({ port: info.port, process: config.process }, "listening"),
  );
  const sandboxClosing = new AbortController();
  let sandboxServer: NodeServer | undefined;
  let internalServer: NodeServer | undefined;
  if (isServer && sandbox && deps) {
    sandboxServer = sandboxListener(i, deps, sandbox, sandboxClosing.signal);
    const liveness = providerLiveness(sandbox.provider, deps.database.db);
    deps.sandboxWire.attach(sandboxServer as Server, {
      verify: sandboxWireVerifier(sandbox.sessionVerifyKeys),
      liveness,
    });
    internalServer = internalListener(i, deps, sandbox, liveness);
  }
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : config.port,
    close() {
      sandboxClosing.abort();
      sandboxServer?.close();
      internalServer?.close();
      // End event streams first so browsers reconnect (with Last-Event-ID) to another replica.
      void deps?.eventStream.hub.close();
      return closeMain(server);
    },
  };
}
