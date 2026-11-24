import type { Context } from "hono";
import type { Logger } from "pino";
import type { KaijuDb } from "@kaiju/db";
import type { RateLimiter } from "../../sandbox/rate-limit.js";
import type { SandboxAuthenticator, SandboxCaller } from "../auth.js";
import type { ObjectStore } from "../object-store.js";
import type { QuotaCheck, WorkspaceLimits } from "../quota.js";

/** Requests per sandbox: a burst big enough for a restore's downloads, then a steady rate. */
export const WORKSPACE_RATE = { capacity: 2000, refillPerSecond: 500 } as const;
/** Manifest, commit and report calls per sandbox: a much smaller bucket on top. */
export const WORKSPACE_META_RATE = { capacity: 120, refillPerSecond: 20 } as const;
/** Restore reports write a row: at most one per sandbox per minute (audit throttled apart). */
export const REPORT_EVERY_MS = 60_000;
/** Concurrent uploads/downloads per sandbox per replica. */
export const WORKSPACE_MAX_TRANSFERS = 16;
/**
 * Database work in flight, per sandbox and per replica. Every workspace endpoint shares the
 * server's connection pool with the user API: one sandbox may hold at most one commit and a few
 * short transactions, and all sandboxes together at most `dbInFlight` connections (beyond: 503,
 * retried), so a compromised sandbox can't starve the API or other tenants.
 */
export interface WorkspaceDbLimits {
  readonly commitsPerSandbox: number;
  readonly othersPerSandbox: number;
  readonly dbInFlight: number;
  /** Separate small pool for ending uploads (they must not be refused, so they wait). */
  readonly finishInFlight: number;
  /** How long a request waits for a replica slot before 503. */
  readonly slotWaitMs: number;
  /** A commit's wait for the workspace row lock (another commit, a collection). */
  readonly lockTimeoutMs: number;
  /**
   * Every other transaction's wait for that lock (upload reservations and finishes, restore
   * reports): short, so a slot is never held long behind a commit — busy answers are retried.
   */
  readonly shortLockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}
export const WORKSPACE_DB_LIMITS: WorkspaceDbLimits = {
  commitsPerSandbox: 1,
  // One sandbox can hold at most 1 + 2 of the replica's 4 slots (downloads' lookups included),
  // and the two short ones only for milliseconds or `shortLockTimeoutMs`: never all of them.
  othersPerSandbox: 2,
  dbInFlight: 4,
  finishInFlight: 2,
  slotWaitMs: 250,
  /** Waiting for the workspace row lock (a long commit, a collection) gives up after this. */
  lockTimeoutMs: 5_000,
  shortLockTimeoutMs: 400,
  statementTimeoutMs: 30_000,
};
/** Throttle for audit rows a looping sandbox could otherwise repeat. */
export const AUDIT_EVERY_MS = 5 * 60_000;
export const INTEGRITY_AUDIT_EVERY_MS = 60_000;
export const MAX_JSON_BYTES = 1024 * 1024;
/** Finish retries on a lock timeout (≈ 30 s of backoff in total, slots released meanwhile). */
export const FINISH_RETRIES = 8;

/** Thrown when an in-flight cap is reached: answered 503/429 with Retry-After. */
export class Busy extends Error {
  constructor(readonly status: 429 | 503) {
    super("busy");
  }
}

/** Counted slots per key with a ceiling; `take` returns an idempotent release or undefined. */
export class Slots {
  /** `take`, retried every 25 ms for up to `waitMs` (a short bounded queue). */
  async wait(key: string, max: number, waitMs: number): Promise<(() => void) | undefined> {
    const until = Date.now() + waitMs;
    for (;;) {
      const release = this.take(key, max);
      if (release || Date.now() >= until) return release;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  readonly #used = new Map<string, number>();
  take(key: string, max: number): (() => void) | undefined {
    const n = this.#used.get(key) ?? 0;
    if (n >= max) return undefined;
    this.#used.set(key, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#used.get(key) ?? 1) - 1;
      if (left <= 0) this.#used.delete(key);
      else this.#used.set(key, left);
    };
  }
}

/** Postgres lock_not_available / query_canceled (our own timeouts), possibly wrapped by Drizzle. */
export function isTimeout(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "55P03" || code === "57014") return true;
  }
  return false;
}

export interface WorkspaceRoutesDeps {
  readonly db: KaijuDb;
  readonly objects: ObjectStore;
  readonly authenticate: SandboxAuthenticator;
  readonly prefix: string;
  readonly limits: WorkspaceLimits;
  readonly quota: QuotaCheck;
  /** Site default of the team object budget (GV2); a new blob past it is refused. */
  readonly teamMaxObjects?: number;
  readonly log: Pick<Logger, "error" | "warn" | "info">;
  readonly limiter?: RateLimiter;
  /** Overrides of {@link WORKSPACE_DB_LIMITS} (tests). */
  readonly dbLimits?: Partial<WorkspaceDbLimits>;
  /** An upload was refused for the workspace's blob budget (collection may free room). */
  readonly onQuotaPressure?: (owner: SandboxCaller) => void;
}

export type Vars = { Variables: { caller: SandboxCaller } };

export const error = (c: Context, status: number, code: string, message: string) =>
  c.json({ code, message }, status as 400);
