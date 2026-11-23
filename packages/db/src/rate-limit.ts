import { sql } from "drizzle-orm";
import type { KobeDb } from "./client.js";

/**
 * Kobe's durable rate limiters (KOBE-809; shared by the server and the model gateway since
 * KOBE-810). All state lives in `kobe_rate_limits` (keys start with "kobe:"), so every replica of
 * every service that connects as the app role sees the same counters. This module is the only
 * place with their SQL. Two shapes, each one atomic upsert per hit:
 *
 * - a **fixed window** ({@link takeRateLimit}, {@link hitRateLimit}): `count` hits per window,
 *   `window_start` = when the window started, `expires_at` = its end;
 * - a **refilling bucket** ({@link takeRateBucket}, KOBE-810), as GCRA (the generic cell rate
 *   algorithm): `window_start` and `expires_at` both hold the bucket's theoretical arrival time
 *   (TAT, epoch ms: when the bucket is full again), `count` is 1 when the last hit was admitted
 *   and 0 when it was refused. A row whose TAT has passed is a full bucket, so the same prune
 *   (`expires_at < now`) removes it without changing anything.
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
  readonly now?: number;
  /** Prune expired rows when a hit starts a new window or finds a full bucket (default true). */
  readonly prune?: boolean;
  /** A failed prune of expired rows (never thrown: the hit has already been counted). */
  readonly onPruneError?: (err: unknown) => void;
}

/** Expired rows one prune deletes at most (KOBE-809); the next new window goes on. */
export const RATE_LIMIT_PRUNE_BATCH = 100;

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
  const now = options.now ?? Date.now();
  const stale = now - rule.windowMs;
  const expires = now + rule.windowMs;
  const result = await db.execute<{ count: number; window_start: string | number }>(sql`
    INSERT INTO kobe_rate_limits AS r (key, count, window_start, expires_at)
    VALUES (${`kobe:${key}`}, 1, ${now}, ${expires})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN r.window_start < ${stale} THEN 1 ELSE r.count + 1 END,
      window_start = CASE WHEN r.window_start < ${stale} THEN ${now} ELSE r.window_start END,
      expires_at = CASE WHEN r.window_start < ${stale} THEN ${expires} ELSE r.expires_at END
    RETURNING count, window_start`);
  const row = result.rows[0];
  const count = row?.count ?? Number.POSITIVE_INFINITY;
  const windowStart = row ? Number(row.window_start) : now;
  if (count === 1 && options.prune !== false) {
    await pruneExpiredRateLimits(db, now, RATE_LIMIT_PRUNE_BATCH, options.onPruneError);
  }
  return {
    allowed: count <= rule.max,
    count,
    windowStart,
    retryAfterMs: Math.max(1, windowStart + rule.windowMs - now),
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

/** Milliseconds per request at the rule's rate, whole and rounded up (never more permissive). */
export function bucketIntervalMs(rule: RateBucketRule): number {
  if (!(rule.burst >= 1 && rule.perSecond > 0)) throw new Error("invalid rate bucket rule");
  return Math.max(1, Math.ceil(1000 / rule.perSecond));
}

/**
 * Takes one request from `key`'s bucket (KOBE-810): the same behaviour as an in-memory token
 * bucket of `burst` refilled at `perSecond`, shared by every replica, in one atomic upsert (GCRA).
 * A refused request is not charged. With T = 1000 / perSecond ms, a request is admitted when
 * `max(TAT, now) + T - now <= burst * T`, and then TAT becomes `max(TAT, now) + T`. A request that
 * finds the bucket full also prunes expired rows (unless `prune: false`). Throws when the database
 * cannot be reached.
 */
export async function takeRateBucket(
  db: RateLimitDb,
  key: string,
  rule: RateBucketRule,
  options: RateLimitOptions = {},
): Promise<RateBucketHit> {
  const now = options.now ?? Date.now();
  const interval = bucketIntervalMs(rule);
  const tolerance = Math.floor(rule.burst) * interval;
  const first = now + interval;
  const result = await db.execute<{ count: number; window_start: string | number }>(sql`
    INSERT INTO kobe_rate_limits AS r (key, count, window_start, expires_at)
    VALUES (${`kobe:${key}`}, 1, ${first}, ${first})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN greatest(r.window_start, ${now}::bigint) + ${interval}::bigint - ${now}::bigint
          <= ${tolerance}::bigint THEN 1 ELSE 0 END,
      window_start = CASE
        WHEN greatest(r.window_start, ${now}::bigint) + ${interval}::bigint - ${now}::bigint
          <= ${tolerance}::bigint
        THEN greatest(r.window_start, ${now}::bigint) + ${interval}::bigint
        ELSE r.window_start END,
      expires_at = CASE
        WHEN greatest(r.window_start, ${now}::bigint) + ${interval}::bigint - ${now}::bigint
          <= ${tolerance}::bigint
        THEN greatest(r.window_start, ${now}::bigint) + ${interval}::bigint
        ELSE r.window_start END
    RETURNING count, window_start`);
  const row = result.rows[0];
  if (!row) throw new Error("rate bucket upsert returned no row");
  const tat = Number(row.window_start);
  if (row.count === 1) {
    // The bucket was full before this request (no row, or its TAT had passed).
    if (tat === first && options.prune !== false) {
      await pruneExpiredRateLimits(db, now, RATE_LIMIT_PRUNE_BATCH, options.onPruneError);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
  // Refused: TAT is unchanged; one request fits once max(TAT, then) + T - then <= burst * T.
  return { allowed: false, retryAfterMs: Math.max(1, tat + interval - tolerance - now) };
}

/**
 * Gives one request back to `key`'s bucket (an admitted call refused right after, for example by
 * a budget): TAT moves back one interval. Never below what a full bucket means.
 */
export async function returnRateBucketToken(
  db: RateLimitDb,
  key: string,
  rule: RateBucketRule,
): Promise<void> {
  const interval = bucketIntervalMs(rule);
  await db.execute(sql`
    UPDATE kobe_rate_limits
       SET window_start = window_start - ${interval}::bigint,
           expires_at = expires_at - ${interval}::bigint
     WHERE key = ${`kobe:${key}`}`);
}

/** Forgets `key`'s counter or bucket (a marker that is no longer true; tests). */
export async function clearRateLimit(db: RateLimitDb, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM kobe_rate_limits WHERE key = ${`kobe:${key}`}`);
}

/**
 * Deletes up to `batch` rows of `kobe_rate_limits` (counters, full buckets and reset-email
 * claims) whose window ended before `now`. Rows another replica is pruning are skipped. A failure
 * goes to `onError`, never thrown: the hit it rides on has already been counted.
 */
export async function pruneExpiredRateLimits(
  db: RateLimitDb,
  now = Date.now(),
  batch = RATE_LIMIT_PRUNE_BATCH,
  onError: (err: unknown) => void = () => undefined,
): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM kobe_rate_limits WHERE key IN (
        SELECT key FROM kobe_rate_limits WHERE expires_at < ${now}
        ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)`);
    return result.rowCount ?? 0;
  } catch (err) {
    onError(err);
    return 0;
  }
}
