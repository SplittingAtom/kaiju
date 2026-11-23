import { once } from "node:events";
import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { withTestLoopback } from "@kobe/address-policy/testing";
import type { AuditEvent } from "@kobe/db";
import { generateSessionKeyPair, signSessionToken } from "@kobe/session-token";
import { pino } from "pino";
import type { EgressDecision } from "../allowlist.js";
import { egressTokenVerifier } from "../auth.js";
import type { ConnectionRecord } from "../connection-audit.js";
import {
  GitDecisionCache,
  type GitAllow,
  type GitDecision,
  type GitDecisionQuery,
} from "../git/decisions.js";
import type { GitSettings } from "../git/types.js";
import { BandwidthLimiter, ConnectionLimits } from "../limits.js";
import { createEgressProxy, tcpConnect, type ProxyDeps } from "../proxy.js";
import { RateBuckets } from "../rate-buckets.js";
import { TunnelRegistry } from "../tunnel-registry.js";

/**
 * A git-enabled egress proxy for tests (KOBE-763): fake policy (the git host is in the site
 * ceiling, not enabled for the team), fake DNS to loopback, a fake server decider, and the
 * upstream TLS server's certificate trusted. Tests only.
 */
export const GIT_HOST = "git.example.test";
export const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
export const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
export const SANDBOX = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
export const CONNECTION = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
/** A made-up token in GitHub's installation-token shape (never a real one). */
export const CREDENTIAL = {
  username: "x-access-token",
  password: "ghs_FAKEfakeFAKEfake0123456789",
};

const PAIR = generateSessionKeyPair();

export function sandboxToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.egress-proxy",
      sub: SANDBOX,
      team_id: TEAM,
      user_id: USER,
      iat: now,
      exp: now + 900,
      jti: "g".repeat(20),
    },
    PAIR.signing,
  );
}

export const proxyAuthorization = () =>
  `Basic ${Buffer.from(`kobe:${sandboxToken()}`).toString("base64")}`;

export function allowFor(q: GitDecisionQuery, overrides: Partial<GitAllow> = {}): GitAllow {
  return {
    decision: "allow",
    connection_id: CONNECTION,
    base_path: q.request.prefix,
    organization: "acme",
    repository: q.request.repository,
    access: q.request.service === "git-receive-pack" ? "write" : "read",
    username: CREDENTIAL.username,
    password: CREDENTIAL.password,
    expires_at: null,
    narrowed: false,
    push_limit_bytes: 10_000,
    ...overrides,
  };
}

/** The fake server: acme on git.example.test; `readonly` repositories refuse pushes. */
export function defaultDecider(q: GitDecisionQuery): GitDecision {
  if (q.host !== GIT_HOST || q.request.prefix !== "") {
    return { decision: "deny", code: "no_connection", message: "No git connection for this host." };
  }
  if (q.request.owner.toLowerCase() !== "acme") {
    return {
      decision: "deny",
      code: "outside_organization",
      message: `${q.request.owner}/${q.request.repository} is outside the organization this Workspace connected on ${q.host} (acme).`,
    };
  }
  if (q.request.repository === "readonly" && q.request.service === "git-receive-pack") {
    return { decision: "deny", code: "read_only", message: "The git connection is read-only." };
  }
  return allowFor(q);
}

export interface GitProxyHarness {
  readonly proxy: Server;
  readonly port: number;
  readonly audit: ConnectionRecord[];
  readonly events: AuditEvent[];
  readonly queries: GitDecisionQuery[];
  readonly connectCalls: string[];
  close(): void;
}

export interface GitProxyOptions {
  readonly upstreamPort: number;
  readonly upstreamCa: string;
  readonly decide?: (q: GitDecisionQuery) => GitDecision | Promise<GitDecision>;
  readonly settings?: Partial<GitSettings>;
  readonly rate?: { burst: number; perSecond: number };
  readonly lookups?: { burst: number; perSecond: number };
  /** Replaces the bandwidth limiter (back-pressure tests). */
  readonly bandwidth?: BandwidthLimiter;
  readonly dns?: Record<string, string[]>;
  readonly internalPattern?: boolean;
}

export async function startGitProxy(options: GitProxyOptions): Promise<GitProxyHarness> {
  const audit: ConnectionRecord[] = [];
  const events: AuditEvent[] = [];
  const queries: GitDecisionQuery[] = [];
  const connectCalls: string[] = [];
  const decide = options.decide ?? defaultDecider;
  const policy = {
    decide: async (): Promise<EgressDecision> => ({ allowed: false, reason: "not_enabled" }),
    decideSite: async (host: string): Promise<EgressDecision> =>
      host === GIT_HOST || host === "internal.example.test" || host === "other.example.test"
        ? options.internalPattern
          ? { allowed: true, pattern: host, internal: true }
          : { allowed: true, pattern: host }
        : { allowed: false, reason: "not_in_ceiling" },
    isActiveMember: async () => true,
  };
  const dns = options.dns ?? {
    [GIT_HOST]: ["127.0.0.1"],
    "other.example.test": ["127.0.0.1"],
    "internal.example.test": ["10.43.0.10"],
  };
  const logger = pino({ level: "silent" });
  const deps: ProxyDeps = {
    verify: egressTokenVerifier(PAIR.verify),
    policy,
    resolve: async (host) => {
      const found = dns[host];
      if (!found) throw new Error("NXDOMAIN");
      return found;
    },
    addresses: withTestLoopback(),
    connections: new ConnectionLimits({ perSandbox: 16, total: 100 }),
    bandwidth: options.bandwidth ?? new BandwidthLimiter(0),
    audit: { record: (r) => void audit.push(r) },
    blocked: { report: () => undefined },
    logger,
    settings: {
      allowedPorts: [443],
      idleTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
      preAuthTimeoutMs: 2_000,
      connectTimeoutMs: 2_000,
      maxTunnelMs: 60_000,
    },
    connectUpstream: (address, port, timeoutMs) => {
      connectCalls.push(`${address}:${port}`);
      return tcpConnect("127.0.0.1", options.upstreamPort, timeoutMs);
    },
    upstreamCa: options.upstreamCa,
    tunnels: new TunnelRegistry(policy, logger),
    git: {
      decisions: new GitDecisionCache(
        async (q) => {
          queries.push(q);
          return decide(q);
        },
        { maxEntries: 100 },
      ),
      settings: {
        maxFetchRequestBytes: 100_000,
        maxResponseBytes: 1_000_000,
        timeoutMs: 10_000,
        ...options.settings,
      },
      concurrency: new ConnectionLimits({ perSandbox: 4, total: 100 }),
      rate: new RateBuckets(options.rate ?? { burst: 1_000, perSecond: 1_000 }),
      lookups: new RateBuckets(options.lookups ?? { burst: 1_000, perSecond: 1_000 }),
      recordEvent: (e) => void events.push(e),
    },
  };
  const proxy = createEgressProxy(deps);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return {
    proxy,
    port: (proxy.address() as AddressInfo).port,
    audit,
    events,
    queries,
    connectCalls,
    close: () => {
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}

export async function listenTls(server: HttpsServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** Writes raw bytes to the proxy and returns everything it answers until it closes. */
export function rawExchange(
  port: number,
  data: string | Buffer,
  timeoutMs = 3_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    }, timeoutMs);
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      if (chunks.length > 0) resolve(Buffer.concat(chunks).toString("latin1"));
      else reject(err);
    });
    socket.write(data);
  });
}
