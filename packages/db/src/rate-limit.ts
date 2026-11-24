import { sql, type SQL } from "drizzle-orm";
import type { KobeDb } from "./client.js";

/**
 * Kaiju's durable rate limiters (KOBE-809; shared by the server and the model gateway since
 * KOBE-810). All state lives in `kobe_rate_limits` (keys start with "kobe:"), so every replica of
 * every service that connects as the app role sees the same counters. This module is the only
 * place with their SQL. Two shapes, each one atomic statement per hit:
 *
 * - a **fixed window** ({@link takeRateLimit}, {@link hitRateLimit}): `count` hits per window,
 *   `window_start` = when the window started, `expires_at` = its end (epoch ms);
 * - a **refilling bucket** ({@link takeRateBucket}, KOBE-810), as GCRA (the generic cell rate
 *   algorithm): `window_start` holds the bucket's theoretical arrival time (TAT, epoch
 *   **microseconds**: when the bucket is full again), `expires_at` the same instant in ms, rounded
 *   up, and `count` is 1 when the last hit was admitted and 0 when it was refused. A row whose TAT
 *   has passed is a full bucket, so the same prune (`expires_at < now`) removes it without changing
 *   anything.
 *
 * **Clock:** unless a caller injects `now` (tests, the sign-in throttle), every function reads the
 * time from the database (`clock_timestamp()`) inside its statement, and a prune that a hit
 * triggers always does, so replicas whose clocks disagree still share one window or bucket and no
 * caller prunes another limit's row early (KOBE-810).
 *
 * Every function takes the pool or an open transaction ({@link RateLimitDb}); inside a
 * transaction pass `prune: false`, so the hit commits or rolls back with it and no prune runs in it.
 */
export type RateLimitDb = Pick<KobeDb, "execute">;

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/** One counted fixed-window hit. */
export interface RateLimitHit {
  /** Whether the hit is within the limit. */
  readonly allowed: boolean;
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** When the current window started (epoch ms). */
  readonly windowStart: number;
  /** Milliseconds until the window ends and a hit is counted afresh (at least 1). */
  readonly retryAfterMs: number;
}

export interface RateLimitOptions {
  /** Epoch ms to use instead of the database clock (tests). */
  readonly now?: number;
  /** Prune expired rows when a hit starts a new window or finds a full bucket (default true). */
  readonly prune?: boolean;
  /** A failed prune of expired rows (never thrown: the hit has already been counted). */
  readonly onPruneError?: (err: unknown) => void;
}

/** Expired rows one prune deletes at most (KOBE-809); the next new window goes on. */
export const RATE_LIMIT_PRUNE_BATCH = 100;

/** The database's clock in epoch ms (or µs), or an injected time. */
function nowMs(now: number | undefined): SQL {
  return now === undefined
    ? sql`(extract(epoch from clock_timestamp()) * 1000)::bigint`
    : sql`${Math.round(now)}::bigint`;
}
function nowUs(now: number | undefined): SQL {
  return now === undefined
    ? sql`(extract(epoch from clock_timestamp()) * 1000000)::bigint`
    : sql`${Math.round(now * 1000)}::bigint`;
}

/**
 * Counts one hit against `key` in a fixed window. The window starts at the first hit and restarts
 * with the first hit after `windowMs`. A hit that starts a new window also deletes up to
 * {@link RATE_LIMIT_PRUNE_BATCH} expired rows, so the table holds about the live windows only.
 * Throws when the database cannot be reached: callers decide whether that refuses or fails.
 */
export async function takeRateLimit(
  db: RateLimitDb,
  key: string,
  rule: RateLimitRule,
  options: RateLimitOptions = {},
): Promise<RateLimitHit> {
  const w = Math.round(rule.windowMs);
  // The insert's own values carry "now" into the conflict branch (EXCLUDED.window_start).
  const result = await db.execute<{
    count: number;
    window_start: string | number;
    now_ms: string | number;
  }>(sql`
    WITH n AS (SELECT ${nowMs(options.now)} AS now_ms),
    up AS (
      INSERT INTO kobe_rate_limits AS r (key, count, window_start, expires_at)
      SELECT ${`kobe:${key}`}, 1, n.now_ms, n.now_ms + ${w}::bigint FROM n
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.window_start < EXCLUDED.window_start - ${w}::bigint
          THEN 1 ELSE r.count + 1 END,
        window_start = CASE WHEN r.window_start < EXCLUDED.window_start - ${w}::bigint
          THEN EXCLUDED.window_start ELSE r.window_start END,
        expires_at = CASE WHEN r.window_start < EXCLUDED.window_start - ${w}::bigint
          THEN EXCLUDED.expires_at ELSE r.expires_at END
      RETURNING count, window_start)
    SELECT up.count, up.window_start, n.now_ms FROM up, n`);
  const row = result.rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  const now = Number(row.now_ms);
  const windowStart = Number(row.window_start);
  if (row.count === 1 && options.prune !== false) {
    // Always the database clock, whatever time the hit was given: no caller prunes early.
    await pruneExpiredRateLimits(db, undefined, RATE_LIMIT_PRUNE_BATCH, options.onPruneError);
  }
  return {
    allowed: row.count <= rule.max,
    count: row.count,
    windowStart,
    retryAfterMs: Math.max(1, windowStart + w - now),
  };
}

/** {@link takeRateLimit}, answering only whether the hit is within the limit. */
export async function hitRateLimit(
  db: RateLimitDb,
  key: string,
  rule: RateLimitRule,
  options: RateLimitOptions = {},
): Promise<boolean> {
  return (await takeRateLimit(db, key, rule, options)).allowed;
}

/** A refilling bucket: `burst` requests at once, refilled at `perSecond`. */
export interface RateBucketRule {
  readonly burst: number;
  readonly perSecond: number;
}

/** One bucket hit. */
export interface RateBucketHit {
  readonly allowed: boolean;
  /** Refused: milliseconds until one request is available again (at least 1). Admitted: 0. */
  readonly retryAfterMs: number;
}

/**
 * Microseconds per request at the rule's rate, rounded up to a whole microsecond (never more
 * permissive; under 0.02 % stricter at the highest member setting, 10,000 a minute).
 */
export function bucketIntervalUs(rule: RateBucketRule): number {
  if (!(rule.burst >= 1 && rule.perSecond > 0)) throw new Error("invalid rate bucket rule");
  return Math.max(1, Math.ceil(1_000_000 / rule.perSecond));
}

/**
 * Takes one request from `key`'s bucket (KOBE-810): the same behaviour as an in-memory token
 * bucket of `burst` refilled at `perSecond`, shared by every replica, in one atomic statement
 * (GCRA). A refused request is not charged. With T = 1 / perSecond (µs), a request is admitted
 * when `max(TAT, now) + T - now <= burst * T`, and then TAT becomes `max(TAT, now) + T`. A request
 * that finds the bucket full also prunes expired rows (unless `prune: false`). Throws when the
 * database cannot be reached.
 */
export async function takeRateBucket(
  db: RateLimitDb,
  key: string,
  rule: RateBucketRule,
  options: RateLimitOptions = {},
): Promise<RateBucketHit> {
  const t = bucketIntervalUs(rule);
  const tolerance = Math.floor(rule.burst) * t;
  // EXCLUDED.window_start is now + T (the TAT of a full bucket's first request), so
  // max(TAT, now) + T = greatest(r.window_start + T, EXCLUDED.window_start).
  const next = sql`greatest(r.window_start + ${t}::bigint, EXCLUDED.window_start)`;
  const admit = sql`${next} - EXCLUDED.window_start <= ${tolerance - t}::bigint`;
  const result = await db.execute<{
    count: number;
    window_start: string | number;
    now_us: string | number;
  }>(sql`
    WITH n AS (SELECT ${nowUs(options.now)} AS now_us),
    up AS (
      INSERT INTO kobe_rate_limits AS r (key, count, window_start, expires_at)
      SELECT ${`kobe:${key}`}, 1, n.now_us + ${t}::bigint,
             (n.now_us + ${t}::bigint + 999) / 1000 FROM n
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${admit} THEN 1 ELSE 0 END,
        window_start = CASE WHEN ${admit} THEN ${next} ELSE r.window_start END,
        expires_at = CASE WHEN ${admit} THEN (${next} + 999) / 1000 ELSE r.expires_at END
      RETURNING count, window_start)
    SELECT up.count, up.window_start, n.now_us FROM up, n`);
  const row = result.rows[0];
  if (!row) throw new Error("rate bucket upsert returned no row");
  const now = Number(row.now_us);
  const tat = Number(row.window_start);
  if (row.count === 1) {
    // The bucket was full before this request (no row, or its TAT had passed).
    if (tat === now + t && options.prune !== false) {
      // Always the database clock, whatever time the hit was given: no caller prunes early.
      await pruneExpiredRateLimits(db, undefined, RATE_LIMIT_PRUNE_BATCH, options.onPruneError);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
  // Refused: TAT is unchanged; one request fits once max(TAT, then) + T - then <= burst * T.
  return {
    allowed: false,
    retryAfterMs: Math.max(1, Math.ceil((tat + t - tolerance - now) / 1000)),
  };
}

/**
 * Gives one request back to `key`'s bucket (an admitted call refused right after, for example by
 * a budget): TAT moves back one interval. Not clamped: a TAT in the past already means a full
 * bucket, and the next request starts from now.
 */
export async function returnRateBucketToken(
  db: RateLimitDb,
  key: string,
  rule: RateBucketRule,
): Promise<void> {
  const t = bucketIntervalUs(rule);
  await db.execute(sql`
    UPDATE kobe_rate_limits
       SET window_start = window_start - ${t}::bigint,
           expires_at = (window_start - ${t}::bigint + 999) / 1000
     WHERE key = ${`kobe:${key}`}`);
}

/**
 * Takes back one fixed-window hit of the window that began at `windowStart` (a hit that turned out
 * not to count, KOBE-812). Nothing when that window is over or the count is already 0.
 */
export async function refundRateLimitHit(
  db: RateLimitDb,
  key: string,
  windowStart: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE kobe_rate_limits SET count = count - 1
     WHERE key = ${`kobe:${key}`} AND window_start = ${windowStart} AND count > 0`);
}

/** Forgets `key`'s counter or bucket (a marker that is no longer true; tests). */
export async function clearRateLimit(db: RateLimitDb, key: string): Promise<void> {
  await clearRateLimits(db, [key]);
}

/** Forgets the counters named (e.g. a sign-in throttle cleared by a successful sign-in). */
export async function clearRateLimits(db: RateLimitDb, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const names = keys.map((k) => `kobe:${k}`);
  await db.execute(
    sql`DELETE FROM kobe_rate_limits WHERE key IN (${sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    )})`,
  );
}

/**
 * Deletes up to `batch` rows of `kobe_rate_limits` (counters, full buckets and reset-email
 * claims) whose window ended before `now` (default: the database clock). Rows another replica is
 * pruning are skipped. A failure goes to `onError`, never thrown: the hit it rides on has already
 * been counted.
 */
export async function pruneExpiredRateLimits(
  db: RateLimitDb,
  now?: number,
  batch = RATE_LIMIT_PRUNE_BATCH,
  onError: (err: unknown) => void = () => undefined,
): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM kobe_rate_limits WHERE key IN (
        SELECT key FROM kobe_rate_limits WHERE expires_at < ${nowMs(now)}
        ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)`);
    return result.rowCount ?? 0;
  } catch (err) {
    onError(err);
    return 0;
  }
}

/**
 * A prune that runs off the request path (KOBE-810): calling the returned function starts
 * {@link pruneExpiredRateLimits} in the background at most once per `everyMs` (this process's
 * clock, used only to space the calls).
 */
export function backgroundPrune(
  db: RateLimitDb,
  options: { readonly everyMs?: number; readonly onError?: (err: unknown) => void } = {},
): (now?: number) => void {
  const every = options.everyMs ?? 10_000;
  let last = Number.NEGATIVE_INFINITY;
  return (now) => {
    const local = Date.now();
    if (local - last < every) return;
    last = local;
    void pruneExpiredRateLimits(db, now, RATE_LIMIT_PRUNE_BATCH, options.onError);
  };
}
