import { SpanKind, idAttributes, recordSpan } from "@kobe/telemetry";
import type { Socket } from "node:net";
import type { SandboxIdentity } from "./auth.js";
import type { ConnectionReason, ConnectionRecord } from "./connection-audit.js";
import type { ConnectUpstream, ConnectionBytes, ProxyDeps } from "./proxy-deps.js";
import type { RateBuckets } from "./rate-buckets.js";
import { reply } from "./proxy-reply.js";

/** One proxy's dependencies as its handlers use them (built once in `createEgressProxy`). */
export interface ProxyRuntime {
  readonly deps: ProxyDeps;
  readonly connectUpstream: ConnectUpstream;
  /** Failed authentications are logged at most a few times per source per minute. */
  readonly authLogs: RateBuckets;
}

export interface Attempt {
  readonly identity: SandboxIdentity;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly started: number;
}

/** Counts an attempt in the connection audit, its span and the log. */
export function finishAttempt(
  rt: ProxyRuntime,
  a: Attempt,
  outcome: ConnectionRecord["outcome"],
  reason: ConnectionReason | undefined,
  bytes: ConnectionBytes = { bytesUp: 0, bytesDown: 0 },
  upgraded = false,
): void {
  const { deps } = rt;
  const { logger } = deps;
  const { identity } = a;
  // A site job (KOBE-343) is audited site-wide: the job, host and outcome, never a token.
  deps.audit.record({
    ...(upgraded ? { upgraded: true } : {}),
    teamId: identity.teamId,
    userId: identity.userId,
    sandboxId: identity.sandboxId,
    domain: a.host,
    port: a.port,
    outcome,
    reason,
    ...bytes,
    ...(identity.site ? { site: identity.site } : {}),
  });
  // Metadata only: the destination host and port (audited anyway), never a path or query.
  recordSpan("egress.connection", {
    startTime: a.started,
    kind: SpanKind.SERVER,
    error: outcome === "failed",
    attributes: {
      ...(identity.site
        ? { "kobe.site_job": identity.site }
        : idAttributes({
            teamId: identity.teamId,
            userId: identity.userId,
            sandboxId: identity.sandboxId,
          })),
      ...(a.host === undefined ? {} : { "server.address": a.host }),
      ...(a.port === undefined ? {} : { "server.port": a.port }),
      "kobe.outcome": outcome,
      ...(reason === undefined ? {} : { "kobe.reason": reason }),
      "kobe.bytes_up": bytes.bytesUp,
      "kobe.bytes_down": bytes.bytesDown,
      "kobe.upgraded": upgraded,
      // KOBE-525: a fixed route per kind, and the set-up latency of a tunnel that opened.
      "http.route": upgraded ? "http-upgrade" : "CONNECT",
      ...(bytes.setupMs === undefined ? {} : { "kobe.setup_ms": bytes.setupMs }),
    },
  });
  logger.info(
    {
      ...(identity.site
        ? { site: identity.site }
        : { team: identity.teamId, user: identity.userId, sandbox: identity.sandboxId }),
      host: a.host,
      port: a.port,
      outcome,
      reason,
      bytesUp: bytes.bytesUp,
      bytesDown: bytes.bytesDown,
      ...(upgraded ? { upgraded: true } : {}),
      ms: Date.now() - a.started,
    },
    "egress connection",
  );
}

/** A refused CONNECT: audited, reported for the run (named host, not a site job), answered. */
export function blockAttempt(
  rt: ProxyRuntime,
  socket: Socket,
  a: Attempt,
  reason: ConnectionReason,
  status: number,
  phrase: string,
  body: string,
  requestAccess = false,
): void {
  finishAttempt(rt, a, "blocked", reason);
  if (a.host !== undefined && a.port !== undefined && !a.identity.site) {
    rt.deps.blocked.report({
      teamId: a.identity.teamId,
      userId: a.identity.userId,
      sandboxId: a.identity.sandboxId,
      domain: a.host,
      port: a.port,
      reason,
      requestAccess,
      threadHint: a.identity.threadHint,
    });
  }
  reply(socket, status, phrase, body);
}
