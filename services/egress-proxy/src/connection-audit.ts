import { SYSTEM_ACTOR, audit, type AuditEvent, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { RateBuckets } from "./rate-buckets.js";

/**
 * Connection log (spec D28 "every connection is logged (domain, team, user, bytes) to the audit
 * view", D31). The audit chain serializes appends, so connections are aggregated: one
 * `egress.connection` row per (team, user, sandbox, host, port, outcome, reason) and flush window,
 * counting every connection exactly once. Each connection is also logged individually by the
 * proxy (stdout, for SIEM forwarding).
 */
export type ConnectionOutcome = "allowed" | "blocked" | "failed";
export type ConnectionReason =
  | "not_enabled"
  | "not_in_ceiling"
  | "forbidden_address"
  | "sni_mismatch"
  | "invalid_target"
  | "port_not_allowed"
  | "plain_http"
  | "connection_limit"
  | "dns_failure"
  | "upstream_unreachable"
  | "policy_unavailable"
  | "inactive_member"
  // KOBE-39 header injection (plain HTTP the proxy upgrades to verified HTTPS).
  | "headers_required"
  | "upstream_tls"
  | "upstream_timeout"
  | "request_too_large"
  | "response_too_large"
  // KOBE-763 git smart-HTTP for connected organizations.
  /** The server refused the git request (the push audit row names its code). */
  | "git_refused"
  /** The sandbox sent its own Authorization or Cookie with a git request. */
  | "credentials_in_request"
  | "rate_limited"
  /** The git host refused the Workspace's credential (401/407 upstream). */
  | "upstream_auth"
  /** The git host answered with a redirect, which is never followed with the credential. */
  | "redirect_refused"
  /** A response carried the credential back: the exchange was cut. */
  | "secret_reflected";

/** The repository (`org/repo`) and service of a git smart-HTTP request (KOBE-763). */
export interface GitTraffic {
  readonly repository: string;
  readonly service: "upload-pack" | "receive-pack";
}

export interface ConnectionRecord {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly domain: string | undefined;
  readonly port: number | undefined;
  readonly outcome: ConnectionOutcome;
  readonly reason: ConnectionReason | undefined;
  readonly bytesUp: number;
  readonly bytesDown: number;
  /** A plain-HTTP request the proxy upgraded to HTTPS with injected headers (KOBE-39). */
  readonly upgraded?: boolean;
  /** A server site job's connection (KOBE-343): audited site-wide, with no team or user. */
  readonly site?: "skill-mirror" | "skill-import";
  /** Git smart-HTTP for a connected organization (KOBE-763): aggregated per repository. */
  readonly git?: GitTraffic;
}

interface Aggregate {
  readonly record: ConnectionRecord;
  readonly aggregated: boolean;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  from: Date;
  to: Date;
}

export type AuditWriter = (events: readonly AuditEvent[]) => Promise<void>;

/** Rows per transaction: each append holds the audit chain lock until commit. */
const ROWS_PER_TX = 100;

export function dbAuditWriter(db: KobeDb): AuditWriter {
  return async (events) => {
    for (let i = 0; i < events.length; i += ROWS_PER_TX) {
      const batch = events.slice(i, i + ROWS_PER_TX);
      await db.transaction(async (tx) => {
        for (const event of batch) await audit(tx, event);
      });
    }
  };
}

export interface ConnectionAuditOptions {
  readonly write: AuditWriter;
  readonly logger: Logger;
  readonly flushMs: number;
  /** Distinct keys kept between flushes; reaching it flushes early. */
  readonly maxKeys?: number;
  readonly now?: () => Date;
  /**
   * New distinct (host, port, outcome, reason) keys per sandbox: burst, then per second. Beyond
   * it a sandbox's connections collapse into one `aggregated` row per outcome (random-host floods).
   */
  readonly distinctKeys?: { readonly burst: number; readonly perSecond: number };
}

const keyOf = (r: ConnectionRecord, aggregated: boolean): string =>
  aggregated
    ? [r.teamId, r.userId, r.sandboxId, "*", "*", r.outcome, "*"].join("|")
    : [
        r.teamId,
        r.userId,
        r.sandboxId,
        r.domain ?? "",
        r.port ?? "",
        r.outcome,
        r.reason ?? "",
        r.upgraded ? "upgraded" : "",
        r.git ? `${r.git.service}:${r.git.repository}` : "",
      ].join("|");

export class ConnectionAudit {
  private pending = new Map<string, Aggregate>();
  /** Individual events (KOBE-763 pushes), written with the next flush. */
  private events: AuditEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private dropped = 0;
  private readonly maxKeys: number;
  private readonly now: () => Date;
  private readonly newKeys: RateBuckets;

  constructor(private readonly options: ConnectionAuditOptions) {
    this.maxKeys = options.maxKeys ?? 5_000;
    this.now = options.now ?? (() => new Date());
    const rate = options.distinctKeys ?? { burst: 32, perSecond: 0.5 };
    this.newKeys = new RateBuckets({ ...rate, now: () => this.now().getTime() });
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.flushMs);
    this.timer.unref();
  }

  record(record: ConnectionRecord): void {
    const at = this.now();
    let aggregated = false;
    let key = keyOf(record, false);
    let existing = this.pending.get(key);
    if (!existing && !this.newKeys.take(`${record.teamId}|${record.sandboxId}`)) {
      aggregated = true;
      key = keyOf(record, true);
      existing = this.pending.get(key);
    }
    if (existing) {
      existing.connections += 1;
      existing.bytesUp += record.bytesUp;
      existing.bytesDown += record.bytesDown;
      existing.to = at;
      return;
    }
    if (this.pending.size >= this.maxKeys * 2) {
      // The database has been unreachable for a while: keep memory bounded, say what was lost.
      this.dropped += 1;
      return;
    }
    this.pending.set(key, {
      record,
      aggregated,
      connections: 1,
      bytesUp: record.bytesUp,
      bytesDown: record.bytesDown,
      from: at,
      to: at,
    });
    if (this.pending.size >= this.maxKeys) void this.flush();
  }

  /**
   * One event written as it is (not aggregated): a git push (KOBE-763). Bounded like the
   * aggregates: beyond `maxKeys` waiting events, new ones are dropped and counted.
   */
  recordEvent(event: AuditEvent): void {
    if (this.events.length >= this.maxKeys) {
      this.dropped += 1;
      return;
    }
    this.events.push(event);
    if (this.events.length >= this.maxKeys / 2) void this.flush();
  }

  /** Writes everything pending; on failure the rows are kept for the next attempt. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0 && this.events.length === 0) return Promise.resolve();
    const batch = this.pending;
    const single = this.events;
    this.pending = new Map();
    this.events = [];
    const events = [...[...batch.values()].map(toEvent), ...single];
    this.flushing = this.options
      .write(events)
      .catch((err: unknown) => {
        this.options.logger.error(
          { err, rows: events.length },
          "egress connection audit could not be written; will retry",
        );
        for (const event of single) {
          if (this.events.length < this.maxKeys) this.events.push(event);
          else this.dropped += 1;
        }
        for (const [key, agg] of batch) {
          const newer = this.pending.get(key);
          if (newer) {
            newer.connections += agg.connections;
            newer.bytesUp += agg.bytesUp;
            newer.bytesDown += agg.bytesDown;
            newer.from = agg.from;
          } else if (this.pending.size < this.maxKeys * 2) {
            this.pending.set(key, agg);
          } else {
            this.dropped += agg.connections;
          }
        }
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.dropped > 0) {
          this.options.logger.error(
            { connections: this.dropped },
            "egress connection audit rows dropped (audit log unreachable)",
          );
          this.dropped = 0;
        }
      });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flushing;
    await this.flush();
  }
}

function siteEvent(agg: Aggregate, job: "skill-mirror" | "skill-import"): AuditEvent {
  const r = agg.record;
  return {
    action: "egress.site_connection",
    actor: SYSTEM_ACTOR,
    target: {
      job,
      ...(agg.aggregated || r.domain === undefined ? {} : { domain: r.domain }),
      ...(agg.aggregated || r.port === undefined ? {} : { port: r.port }),
      outcome: r.outcome,
      ...(agg.aggregated || r.reason === undefined
        ? {}
        : { reason: r.reason as SiteConnectionReason }),
      ...(agg.aggregated ? { aggregated: true as const } : {}),
      connections: agg.connections,
      bytesUp: agg.bytesUp,
      bytesDown: agg.bytesDown,
      from: agg.from.toISOString(),
      to: agg.to.toISOString(),
    },
  };
}

type SiteConnectionReason = Extract<
  AuditEvent,
  { action: "egress.site_connection" }
>["target"]["reason"];

function toEvent(agg: Aggregate): AuditEvent {
  const r = agg.record;
  if (r.site) return siteEvent(agg, r.site);
  return {
    action: "egress.connection",
    actor: SYSTEM_ACTOR,
    teamId: r.teamId,
    target: {
      userId: r.userId,
      sandboxId: r.sandboxId,
      ...(agg.aggregated || r.domain === undefined ? {} : { domain: r.domain }),
      ...(agg.aggregated || r.port === undefined ? {} : { port: r.port }),
      outcome: r.outcome,
      ...(agg.aggregated || r.reason === undefined ? {} : { reason: r.reason }),
      ...(agg.aggregated ? { aggregated: true as const } : {}),
      ...(!agg.aggregated && r.upgraded ? { upgraded: true as const } : {}),
      ...(!agg.aggregated && r.git
        ? { repository: r.git.repository, gitService: r.git.service }
        : {}),
      connections: agg.connections,
      bytesUp: agg.bytesUp,
      bytesDown: agg.bytesDown,
      from: agg.from.toISOString(),
      to: agg.to.toISOString(),
    },
  };
}
