import { sql } from "drizzle-orm";
import type { KobeDb } from "./client.js";

/**
 * Kobe's durable fixed-window rate limiter (KOBE-809, shared by the server and the model gateway
 * since KOBE-810). Counters live in `kobe_rate_limits` (keys start with "kobe:"), so every replica
 * of every service that connects as the app role sees the same ones.
 */
export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/** One counted hit. */
export interface RateLimitHit {
  /** Whether the hit is within the limit. */
  readonly allowed: boolean;
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** When the current window started (epoch ms): what {@link returnRateLimitHit} names. */
  readonly windowStart: number;
  /** Milliseconds until the window ends and a hit is counted afresh (at least 1). */
  readonly retryAfterMs: number;
}

export interface RateLimitOptions {
  readonly now?: number;
  /** A failed prune of expired rows (never thrown: the hit has already been counted). */
  readonly onPruneError?: (err: unknown) => void;
}

/** Expired rows one prune deletes at most (KOBE-809); the next new window goes on. */
export const RATE_LIMIT_PRUNE_BATCH = 100;

/**
 * Counts one hit against `key` in a fixed window: one atomic upsert, no read-modify-write race.
 * The window starts at the first hit and restarts with the first hit after `windowMs`. A hit that
 * starts a new window also deletes up to {@link RATE_LIMIT_PRUNE_BATCH} expired rows, so the table
 * holds about the live windows only. Throws when the database cannot be reached: callers decide
 * whether that refuses (the model gateway does) or fails the request.
 */
export async function takeRateLimit(
  db: KobeDb,
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
  if (count === 1)
    await pruneExpiredRateLimits(db, now, RATE_LIMIT_PRUNE_BATCH, options.onPruneError);
  return {
    allowed: count <= rule.max,
    count,
    windowStart,
    retryAfterMs: Math.max(1, windowStart + rule.windowMs - now),
  };
}

/** {@link takeRateLimit}, answering only whether the hit is within the limit. */
export async function hitRateLimit(
  db: KobeDb,
  key: string,
  rule: RateLimitRule,
  options: RateLimitOptions = {},
): Promise<boolean> {
  return (await takeRateLimit(db, key, rule, options)).allowed;
}

/**
 * Takes back one hit of the window that started at `windowStart` (a call admitted by the limit
 * but refused right after, for example by a budget). A later window, or a count already at 0, is
 * left alone.
 */
export async function returnRateLimitHit(
  db: KobeDb,
  key: string,
  windowStart: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE kobe_rate_limits SET count = count - 1
     WHERE key = ${`kobe:${key}`} AND window_start = ${windowStart} AND count > 0`);
}

/**
 * Deletes up to `batch` rows of `kobe_rate_limits` (counters and reset-email claims) whose window
 * ended before `now`. Rows another replica is pruning are skipped. A failure goes to `onError`,
 * never thrown: the hit it rides on has already been counted.
 */
export async function pruneExpiredRateLimits(
  db: KobeDb,
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
