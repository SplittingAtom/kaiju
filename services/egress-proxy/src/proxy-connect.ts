import type { IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { normalizeHost } from "@kaiju/db";
import type { EgressDecision } from "./allowlist.js";
import { authenticate } from "./auth.js";
import type { ConnectUpstream } from "./proxy-deps.js";
import { readClientHello, sniMatches } from "./proxy-hello.js";
import { blockAttempt, finishAttempt, type Attempt, type ProxyRuntime } from "./proxy-outcome.js";
import { reply } from "./proxy-reply.js";
import { runTunnel } from "./tunnel.js";

const REALM = 'Basic realm="kobe-egress"';

type Allowed = Extract<EgressDecision, { allowed: true }>;

/** `host:port` (or `[v6]:port`) of a CONNECT request. */
export function parseConnectTarget(
  url: string | undefined,
): { host: string; port: number } | undefined {
  if (!url || url.length > 300) return undefined;
  const colon = url.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const rawPort = url.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return undefined;
  let host = url.slice(0, colon);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host ? { host, port } : undefined;
}

/** One CONNECT: authentication, a tunnel slot, then the set-up (see `ProxySettings` docs). */
export async function handleConnect(
  rt: ProxyRuntime,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<void> {
  const { deps } = rt;
  const { logger, settings } = deps;
  const started = Date.now();
  socket.setNoDelay(true);
  socket.on("error", () => socket.destroy());
  // Bounds the whole set-up (policy lookups, DNS, connect, ClientHello); the tunnel then sets
  // its own idle timeout on the same socket.
  socket.setTimeout(settings.handshakeTimeoutMs + settings.connectTimeoutMs * 2, () =>
    socket.destroy(),
  );
  socket.pause();

  const auth = authenticate(req.headers["proxy-authorization"], deps.verify, deps.verifySite);
  if (!auth.ok) {
    const source = socket.remoteAddress ?? "unknown";
    if (rt.authLogs.take(source)) {
      logger.info({ reason: auth.reason, remote: source }, "egress proxy auth refused");
    }
    reply(
      socket,
      407,
      "Proxy Authentication Required",
      "Kaiju egress proxy: send the sandbox's egress session token.",
      [`Proxy-Authenticate: ${REALM}`],
    );
    return;
  }
  const identity = auth.identity;
  // Authenticated sockets leave the pre-auth pool and hold one of the sandbox's tunnel slots
  // from here on (set-up included), so set-up floods are bounded per sandbox too.
  deps.preauth?.authenticated(socket);
  const target = parseConnectTarget(req.url);
  const host = target ? normalizeHost(target.host) : null;
  const attempt: Attempt = { identity, host: host ?? undefined, port: target?.port, started };
  const release = deps.connections.tryAcquire(identity.sandboxId);
  if (!release) {
    blockAttempt(
      rt,
      socket,
      attempt,
      "connection_limit",
      429,
      "Kaiju egress: too many connections",
      "Kaiju egress: this sandbox has too many open connections; close some and retry.",
    );
    return;
  }
  try {
    await setUp(rt, socket, head, attempt, target, host);
  } finally {
    release();
  }
}

async function setUp(
  rt: ProxyRuntime,
  socket: Socket,
  head: Buffer,
  attempt: Attempt,
  target: { host: string; port: number } | undefined,
  host: string | null,
): Promise<void> {
  const { settings } = rt.deps;
  if (!target || host === null || isIP(target.host) !== 0) {
    blockAttempt(
      rt,
      socket,
      attempt,
      "invalid_target",
      403,
      "Kaiju egress blocked: invalid target",
      "Kaiju egress: CONNECT needs a host name and port (IP addresses are never allowed).",
    );
    return;
  }
  if (!settings.allowedPorts.includes(target.port)) {
    blockAttempt(
      rt,
      socket,
      attempt,
      "port_not_allowed",
      403,
      `Kaiju egress blocked: port ${target.port} is not allowed`,
      `Kaiju egress: only HTTPS ports ${settings.allowedPorts.join(", ")} are allowed.`,
    );
    return;
  }
  const decision = await decideConnect(rt, socket, attempt, host);
  if (!decision) return;
  await openTunnel(rt, socket, head, attempt, target.port, host, decision);
}

/** Membership, the allowlist and header injection; answers every refusal itself. */
async function decideConnect(
  rt: ProxyRuntime,
  socket: Socket,
  attempt: Attempt,
  host: string,
): Promise<Allowed | undefined> {
  const { deps } = rt;
  const { logger } = deps;
  const { identity } = attempt;
  let decision: EgressDecision;
  try {
    if (identity.site) decision = await deps.policy.decideSite(host);
    else if (!(await deps.policy.isActiveMember(identity.teamId, identity.userId))) {
      finishAttempt(rt, attempt, "blocked", "inactive_member");
      reply(
        socket,
        403,
        "Kaiju egress blocked: not an active team member",
        "Kaiju egress: this sandbox's user is not an active member of its team.",
      );
      return undefined;
    } else decision = await deps.policy.decide(identity.teamId, host);
  } catch (err) {
    logger.error({ err, team: identity.teamId }, "egress allowlist unavailable");
    finishAttempt(rt, attempt, "failed", "policy_unavailable");
    reply(
      socket,
      503,
      "Kaiju egress: allowlist unavailable",
      "Kaiju egress: the allowlist could not be read; try again shortly.",
    );
    return undefined;
  }
  if (!decision.allowed) {
    if (decision.reason === "not_enabled") {
      blockAttempt(
        rt,
        socket,
        attempt,
        "not_enabled",
        403,
        `Kaiju egress blocked: ${host} is not enabled for this team`,
        `Kaiju egress: ${host} is not enabled for this team. A team admin can enable it (Request access).`,
        true,
      );
    } else {
      // EA1: a site admin can decide it (adds it to the ceiling and enables it), so ask.
      blockAttempt(
        rt,
        socket,
        attempt,
        "not_in_ceiling",
        403,
        `Kaiju egress blocked: ${host} is not allowed on this site`,
        `Kaiju egress: ${host} is not in this site's egress ceiling; a site admin must add it first (Request access).`,
        true,
      );
    }
    return undefined;
  }

  // Header injection (KOBE-39): a tunnel can't carry the team's headers; say how to get them.
  let injected: string | undefined;
  try {
    injected =
      deps.headers && !identity.site
        ? await deps.policy.sealedHeaders?.(identity.teamId, decision.pattern)
        : undefined;
  } catch (err) {
    logger.error({ err, team: identity.teamId }, "egress header rules unavailable");
    finishAttempt(rt, attempt, "failed", "policy_unavailable");
    reply(
      socket,
      503,
      "Kaiju egress: allowlist unavailable",
      "Kaiju egress: the allowlist could not be read; try again shortly.",
    );
    return undefined;
  }
  if (injected !== undefined) {
    finishAttempt(rt, attempt, "blocked", "headers_required");
    reply(
      socket,
      403,
      `Kaiju egress blocked: use http://${host} (team credentials are injected)`,
      `Kaiju egress: your team injects credentials for ${host}. Use http://${host}/... instead of ` +
        "https:// — the proxy adds them and connects over verified HTTPS for you.",
    );
    return undefined;
  }
  return decision;
}

/** Resolve, check every address, connect to a checked one, verify the SNI, relay. */
async function openTunnel(
  rt: ProxyRuntime,
  socket: Socket,
  head: Buffer,
  attempt: Attempt,
  port: number,
  host: string,
  decision: Allowed,
): Promise<void> {
  const { deps, connectUpstream } = rt;
  const { logger, settings } = deps;
  const { identity } = attempt;
  const detach = deps.bandwidth.attach(identity.sandboxId);
  let upstream: Socket | undefined;
  try {
    let addresses: string[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      finishAttempt(rt, attempt, "failed", "dns_failure");
      reply(
        socket,
        502,
        `Kaiju egress: cannot resolve ${host}`,
        `Kaiju egress: ${host} does not resolve.`,
      );
      return;
    }
    // EA4: internal targets only for a host whose matching pattern is internal.
    const internal = decision.internal === true;
    if (deps.addresses.checkAll(addresses, { internal }) !== "allowed") {
      // A host name (IP literals were refused above): a site admin can mark it internal (EA4).
      blockAttempt(
        rt,
        socket,
        attempt,
        "forbidden_address",
        403,
        `Kaiju egress blocked: ${host} resolves to an internal address`,
        `Kaiju egress: ${host} resolves to an internal or reserved address, which sandboxes may not reach unless a site admin marks it internal (Request access).`,
        true,
      );
      return;
    }
    // Reached through an internal target: re-checks close it once the pattern stops being internal.
    const internalReach = internal && deps.addresses.checkAll(addresses) !== "allowed";
    upstream = await firstReachable(addresses, port, settings.connectTimeoutMs, connectUpstream);
    if (!upstream) {
      finishAttempt(rt, attempt, "failed", "upstream_unreachable");
      reply(
        socket,
        502,
        `Kaiju egress: cannot connect to ${host}`,
        `Kaiju egress: ${host} did not accept a connection.`,
      );
      return;
    }
    if (socket.destroyed) return;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const setupMs = Date.now() - attempt.started;

    const hello = await readClientHello(socket, head, settings.handshakeTimeoutMs);
    if (!sniMatches(hello.serverName, host)) {
      // The tunnel is open: no HTTP status can be sent any more, so the connection is cut.
      finishAttempt(rt, attempt, "blocked", "sni_mismatch");
      if (!identity.site)
        deps.blocked.report({
          teamId: identity.teamId,
          userId: identity.userId,
          sandboxId: identity.sandboxId,
          domain: host,
          port,
          reason: "sni_mismatch",
          requestAccess: false,
          threadHint: identity.threadHint,
        });
      logger.info(
        { team: identity.teamId, host, why: hello.why },
        "egress tunnel refused: TLS server name does not match",
      );
      socket.destroy();
      return;
    }
    const tunnel = upstream;
    upstream = undefined;
    // Revocation reaches open tunnels: re-checked on change hints, closed at token expiry or
    // the maximum tunnel age, whichever comes first.
    const unregister = deps.tunnels?.register(
      {
        teamId: identity.teamId,
        userId: identity.userId,
        ...(identity.site ? { site: true } : {}),
        host,
        ...(internalReach ? { internal: true } : {}),
        close: (reason) => {
          logger.info({ team: identity.teamId, host, reason }, "egress tunnel closed by policy");
          socket.destroy();
          tunnel.destroy();
        },
      },
      Math.min(identity.expiresAt, Date.now() + settings.maxTunnelMs),
    );
    try {
      const bytes = await runTunnel({
        client: socket,
        upstream: tunnel,
        initial: hello.bytes,
        throttle: (n) => deps.bandwidth.take(identity.sandboxId, n),
        idleTimeoutMs: settings.idleTimeoutMs,
      });
      finishAttempt(rt, attempt, "allowed", undefined, { ...bytes, setupMs });
    } finally {
      unregister?.();
    }
  } finally {
    upstream?.destroy();
    detach();
  }
}

async function firstReachable(
  addresses: readonly string[],
  port: number,
  timeoutMs: number,
  connect: ConnectUpstream,
): Promise<Socket | undefined> {
  // IPv4 first: clusters often have no IPv6 egress.
  const ordered = [...addresses].sort((a, b) => isIP(a) - isIP(b)).slice(0, 3);
  for (const address of ordered) {
    try {
      return await connect(address, port, timeoutMs);
    } catch {
      // try the next address
    }
  }
  return undefined;
}
