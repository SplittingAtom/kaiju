import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import type { InjectedHeader } from "@kaiju/db";
import type { ConnectionReason } from "./connection-audit.js";
import type { UpgradeSettings } from "./proxy-deps.js";
import { downstreamHeaders, upstreamHeaders } from "./upgrade-headers.js";
import { holdUntilReady, overBuffered, type FlowDestination, type FlowSource } from "./flow.js";
import { reply } from "./upgrade-reply.js";
import type { UpgradeAttempt, UpgradeContext } from "./upgrade-types.js";

const UPSTREAM_PORT = 443;

export interface PlainTarget {
  readonly host: string;
  readonly path: string;
}

async function verifiedTls(
  tcp: Socket,
  host: string,
  timeoutMs: number,
  ca: string | Buffer | readonly (string | Buffer)[] | undefined,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket: tcp,
      servername: host,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      ...(ca === undefined ? {} : { ca: ca as string | Buffer | (string | Buffer)[] }),
      // The certificate must name the host the sandbox asked for (never the address).
      checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
    });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error("TLS handshake timeout"));
    }, timeoutMs);
    tls.once("secureConnect", () => {
      clearTimeout(timer);
      tls.removeAllListeners("error");
      tls.on("error", () => tls.destroy());
      resolve(tls);
    });
    tls.once("error", (err) => {
      clearTimeout(timer);
      tcp.destroy();
      reject(err);
    });
  });
}

/** Connects to a checked address on 443 and verifies TLS for the host; answers a failure itself. */
export async function connectVerified(
  ctx: UpgradeContext,
  res: ServerResponse,
  attempt: UpgradeAttempt,
  host: string,
  addresses: readonly string[],
): Promise<TLSSocket | undefined> {
  const { deps } = ctx;
  const { identity } = attempt;
  const connect = deps.connectUpstream;
  if (!connect) throw new Error("connectUpstream missing");
  // IPv4 first, at most 3 checked addresses: the same rule as tunnels.
  const ordered = [...addresses].sort((a, b) => isIP(a) - isIP(b)).slice(0, 3);
  let tcp: Socket | undefined;
  for (const address of ordered) {
    try {
      tcp = await connect(address, UPSTREAM_PORT, deps.settings.connectTimeoutMs);
      break;
    } catch {
      // next address
    }
  }
  if (!tcp) {
    ctx.finish(attempt, "failed", "upstream_unreachable");
    reply(
      res,
      502,
      `Kaiju egress: cannot connect to ${host}`,
      `Kaiju egress: ${host} did not accept a connection.`,
    );
    return undefined;
  }
  try {
    return await verifiedTls(tcp, host, deps.settings.handshakeTimeoutMs, deps.upstreamCa);
  } catch (err) {
    deps.logger.info(
      { team: identity.teamId, host, why: (err as Error).message },
      "egress upgrade: TLS refused",
    );
    ctx.finish(attempt, "failed", "upstream_tls");
    reply(
      res,
      502,
      `Kaiju egress: ${host} TLS could not be verified`,
      `Kaiju egress: ${host}'s HTTPS certificate could not be verified for that name.`,
    );
    return undefined;
  }
}

/** One upgraded request's relay: its streams, limits and running counts. */
interface Relay {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly outgoing: ClientRequest;
  readonly tls: TLSSocket;
  readonly limits: UpgradeSettings;
  readonly host: string;
  readonly injected: readonly InjectedHeader[];
  bytesUp: number;
  bytesDown: number;
  failure: ConnectionReason | undefined;
  /** Ends the exchange: an error status while nothing was relayed yet, a cut connection after. */
  readonly fail: (reason: ConnectionReason) => void;
  /** Pauses `src` until `dst` drained (if `flushed` is false) and the bandwidth delay passed. */
  readonly forwarded: (src: FlowSource, dst: FlowDestination, flushed: boolean, n: number) => void;
}

/** The upgraded request itself, once TLS to the checked address is verified. */
export async function exchange(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
  attempt: UpgradeAttempt,
  target: PlainTarget,
  addresses: readonly string[],
  injected: readonly InjectedHeader[],
  length: number | undefined,
): Promise<void> {
  const { deps } = ctx;
  const limits = deps.upgrade as UpgradeSettings;
  const { host } = target;
  const { identity } = attempt;
  const deadline = attempt.started + limits.timeoutMs;
  const tls = await connectVerified(ctx, res, attempt, host, addresses);
  if (!tls) return;

  const setupMs = Date.now() - attempt.started;
  const timers = new Set<NodeJS.Timeout>();
  const outgoing = httpRequest({
    createConnection: () => tls,
    method: req.method,
    path: target.path,
    headers: upstreamHeaders(req.rawHeaders, host, injected, length).flat() as unknown as Record<
      string,
      string
    >,
    setHost: false,
  });
  const relay: Relay = {
    req,
    res,
    outgoing,
    tls,
    limits,
    host,
    injected,
    bytesUp: 0,
    bytesDown: 0,
    failure: undefined,
    fail: (reason) => {
      if (relay.failure !== undefined) return;
      relay.failure = reason;
      outgoing.destroy();
      tls.destroy();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        reason === "upstream_timeout" ? 504 : reason === "request_too_large" ? 413 : 502;
      reply(
        res,
        status,
        `Kaiju egress: ${host} request failed`,
        `Kaiju egress: the request to ${host} failed (${reason}).`,
      );
    },
    // KOBE-763 review M2: resume only when the destination drained AND the throttle allows.
    forwarded: (src, dst, flushed, n) => {
      if (overBuffered(dst)) {
        fail("buffer_limit");
        return;
      }
      holdUntilReady(src, dst, flushed, deps.bandwidth.take(identity.sandboxId, n), timers);
    },
  };
  const { fail } = relay;
  const overall = setTimeout(() => fail("upstream_timeout"), Math.max(0, deadline - Date.now()));
  const unregister = deps.tunnels?.register(
    {
      teamId: identity.teamId,
      userId: identity.userId,
      host,
      close: () => {
        fail("not_enabled");
        res.destroy();
      },
    },
    // Only the token lifetime: the request deadline is enforced by `overall` above. Registering
    // it here too made two timers race at the same instant, and the registry's (reason
    // not_enabled, 502) could beat `overall` (upstream_timeout, 504).
    identity.expiresAt,
  );
  tls.setTimeout(deps.settings.idleTimeoutMs, () => fail("upstream_timeout"));

  const done = untilDone(relay);
  pipeRequest(relay);

  try {
    await done;
  } finally {
    clearTimeout(overall);
    for (const t of timers) clearTimeout(t);
    unregister?.();
    tls.destroy();
  }
  const bytes = { bytesUp: relay.bytesUp, bytesDown: relay.bytesDown, setupMs };
  if (relay.failure !== undefined) {
    ctx.finish(attempt, "failed", relay.failure, bytes, true);
  } else {
    ctx.finish(attempt, "allowed", undefined, bytes, true);
  }
}

/** Settles when the client's response closes or the upstream request fails. */
function untilDone(relay: Relay): Promise<void> {
  const { res, outgoing, fail } = relay;
  return new Promise<void>((resolve) => {
    const finishOnce = (() => {
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        resolve();
      };
    })();
    res.once("close", finishOnce);
    outgoing.once("error", () => {
      fail("upstream_unreachable");
      finishOnce();
    });
    outgoing.once("response", (upstreamRes: IncomingMessage) => relayResponse(relay, upstreamRes));
  });
}

/** The upstream's response to the sandbox: headers filtered, size-capped, throttled. */
function relayResponse(relay: Relay, upstreamRes: IncomingMessage): void {
  const { res, tls, limits, host, injected, fail } = relay;
  const declared = Number(upstreamRes.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
    relay.failure = "response_too_large";
    reply(
      res,
      502,
      "Kaiju egress: response too large",
      `Kaiju egress: responses are limited to ${limits.maxResponseBytes} bytes.`,
    );
    upstreamRes.destroy();
    tls.destroy();
    return;
  }
  const headers = downstreamHeaders(upstreamRes.rawHeaders, host, injected);
  if (upstreamRes.headers["content-length"] !== undefined) {
    headers.push(["Content-Length", String(upstreamRes.headers["content-length"])]);
  }
  // One request per connection: an authenticated socket has left the pre-auth budget and
  // holds a connection slot only while its request runs, so it must not idle afterwards.
  headers.push(["Connection", "close"]);
  // The upstream's reason phrase is not relayed (Node's standard one is used).
  res.writeHead(upstreamRes.statusCode ?? 502, headers.flat());
  upstreamRes.on("data", (chunk: Buffer) => {
    relay.bytesDown += chunk.length;
    if (relay.bytesDown > limits.maxResponseBytes) {
      upstreamRes.destroy();
      fail("response_too_large");
      return;
    }
    relay.forwarded(upstreamRes, res, res.write(chunk), chunk.length);
  });
  upstreamRes.once("end", () => res.end());
  upstreamRes.once("error", () => fail("upstream_unreachable"));
}

/** The sandbox's request body to the upstream, size-capped and throttled. */
function pipeRequest(relay: Relay): void {
  const { req, outgoing, limits, fail } = relay;
  req.on("data", (chunk: Buffer) => {
    relay.bytesUp += chunk.length;
    if (relay.bytesUp > limits.maxRequestBytes) {
      fail("request_too_large");
      return;
    }
    relay.forwarded(req, outgoing, outgoing.write(chunk), chunk.length);
  });
  req.once("end", () => outgoing.end());
  req.once("error", () => fail("upstream_unreachable"));
}
