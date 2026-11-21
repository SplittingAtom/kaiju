import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { handleConnect } from "./proxy-connect.js";
import type { ConnectUpstream, ProxyDeps } from "./proxy-deps.js";
import { finishAttempt, type ProxyRuntime } from "./proxy-outcome.js";
import { closeSoon } from "./proxy-reply.js";
import { RateBuckets } from "./rate-buckets.js";
import { handlePlainHttp, type UpgradeContext } from "./upgrade.js";

export type {
  ConnectionBytes,
  ConnectUpstream,
  ProxyDeps,
  ProxyPolicy,
  ProxySettings,
} from "./proxy-deps.js";
export { parseConnectTarget } from "./proxy-connect.js";
export { sniMatches } from "./proxy-hello.js";

const SERVICE = "egress-proxy";

export const tcpConnect: ConnectUpstream = (address, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      // Until the tunnel takes over (it adds its own handler): an error just closes the socket.
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

/** The egress proxy server (behaviour: `ProxySettings` in proxy-deps.ts). */
export function createEgressProxy(deps: ProxyDeps): Server {
  const { logger, settings } = deps;
  const connectUpstream = deps.connectUpstream ?? tcpConnect;
  const rt: ProxyRuntime = {
    deps,
    connectUpstream,
    // Failed authentications are logged at most a few times per source per minute.
    authLogs: new RateBuckets({ burst: 5, perSecond: 0.1 }),
  };

  const server = createServer({
    maxHeaderSize: 8192,
    // Request heads must arrive within the pre-auth bound (headersTimeout below); an upgraded
    // plain-HTTP request's body is bounded by its own deadline (upgrade.ts), not this.
    requestTimeout: deps.upgrade
      ? deps.upgrade.timeoutMs + settings.connectTimeoutMs + settings.handshakeTimeoutMs
      : settings.preAuthTimeoutMs,
    // How often Node enforces headersTimeout/requestTimeout (default 30 s): slow-loris bound.
    connectionsCheckingInterval: Math.min(1_000, settings.preAuthTimeoutMs),
  });
  server.headersTimeout = settings.preAuthTimeoutMs;
  if (deps.preauth) {
    const gate = deps.preauth;
    server.on("connection", (socket: Socket) => void gate.admit(socket));
  }
  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    handleConnect(rt, req, socket, head).catch((err: unknown) => {
      logger.error({ err }, "egress proxy connect handler failed");
      socket.destroy();
    });
  });
  const upgradeContext = upgradeContextOf(rt);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url.startsWith("/")) {
      handleRequest(req, res, deps);
      return;
    }
    // Absolute-form: a plain-HTTP proxy request (KOBE-39 upgrade path, refused otherwise).
    handlePlainHttp(req, res, upgradeContext).catch((err: unknown) => {
      logger.error({ err }, "egress proxy plain-HTTP handler failed");
      res.destroy();
    });
  });
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status =
      err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    closeSoon(socket);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  });
  return server;
}

/** What upgrade.ts needs from the proxy: its deps, the audit, run reports and auth logging. */
function upgradeContextOf(rt: ProxyRuntime): UpgradeContext {
  const { deps, connectUpstream } = rt;
  const { logger } = deps;
  return {
    deps: { ...deps, connectUpstream },
    finish: (a, outcome, reason, bytes, upgraded) => {
      finishAttempt(rt, a, outcome, reason, bytes, upgraded);
    },
    report: (a, reason, requestAccess) => {
      if (a.host === undefined) return;
      deps.blocked.report({
        teamId: a.identity.teamId,
        userId: a.identity.userId,
        sandboxId: a.identity.sandboxId,
        domain: a.host,
        port: a.port ?? 80,
        reason,
        requestAccess,
        threadHint: a.identity.threadHint,
      });
    },
    authRefused: (source, reason) => {
      if (rt.authLogs.take(source))
        logger.info({ reason, remote: source }, "egress proxy auth refused");
    },
  };
}

/** Health endpoints (origin-form requests); absolute-form ones go to upgrade.ts. */
function handleRequest(req: IncomingMessage, res: ServerResponse, deps: ProxyDeps): void {
  const json = (status: number, body: unknown) => {
    // Close after answering: an unauthenticated socket must not linger (pre-auth budget).
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (url.startsWith("/") && req.method === "GET") {
    if (url === "/healthz") return json(200, { status: "ok", service: SERVICE });
    if (url === "/readyz") {
      const ready = deps.ready?.() ?? true;
      return json(ready ? 200 : 503, { status: ready ? "ready" : "draining", service: SERVICE });
    }
    return json(404, { status: "not_found", service: SERVICE });
  }
  json(405, { status: "method_not_allowed", service: SERVICE });
}
