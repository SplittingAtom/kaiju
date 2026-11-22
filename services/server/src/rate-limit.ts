import { inArray, kobeRateLimits, sql, type KobeDb } from "@kobe/db";
import { logger } from "./logger.js";

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/** Expired rows one prune deletes at most (KOBE-809); the next new window goes on. */
export const RATE_LIMIT_PRUNE_BATCH = 100;

/** One counter as a hit left it: hits in the window so far and when the window began (epoch ms). */
export interface RateLimitHit {
  readonly count: number;
  readonly windowStart: number;
}

/**
 * Counts one hit against `key` in a fixed window and says whether it is within the limit. Counters
 * live in Postgres' `kobe_rate_limits` (keys start with "kobe:"), so every replica sees the same
 * ones; not in Better Auth's `rate_limits`, which the library prunes of every row older than its
 * own 60 s window (KOBE-809). One atomic upsert; no read-modify-write race. A hit that starts a new
 * window also deletes up to {@link RATE_LIMIT_PRUNE_BATCH} expired rows, so the table holds about
 * the live windows only.
 */
export async function hitRateLimit(
  db: KobeDb,
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): Promise<boolean> {
  return (await countRateLimitHit(db, key, rule, now)).count <= rule.max;
}

/**
 * {@link hitRateLimit}, answering the counter itself: callers that need more than "within the
 * limit" (the sign-in throttle's threshold and retry hint, KOBE-812). `rule.max` is not used.
 */
export async function countRateLimitHit(
  db: KobeDb,
  key: string,
  rule: Pick<RateLimitRule, "windowMs">,
  now = Date.now(),
): Promise<RateLimitHit> {
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
  if (count === 1) await pruneExpiredRateLimits(db, now);
  return { count, windowStart: row ? Number(row.window_start) : now };
}

/**
 * Takes back one hit counted by {@link countRateLimitHit} in the window that began at
 * `windowStart` (a hit that turned out not to count, KOBE-812). Nothing when that window is over.
 */
export async function refundRateLimitHit(
  db: KobeDb,
  key: string,
  windowStart: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE kobe_rate_limits SET count = count - 1
    WHERE key = ${`kobe:${key}`} AND window_start = ${windowStart} AND count > 0`);
}

/** Deletes the counters named (e.g. a sign-in throttle cleared by a successful sign-in). */
export async function clearRateLimits(db: KobeDb, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(kobeRateLimits).where(
    inArray(
      kobeRateLimits.key,
      keys.map((k) => `kobe:${k}`),
    ),
  );
}

/**
 * Deletes up to `batch` rows of `kobe_rate_limits` (counters and reset-email claims) whose window
 * ended before `now`. Rows another replica is pruning are skipped. A failure is logged, never
 * thrown: the hit it rides on has already been counted.
 */
export async function pruneExpiredRateLimits(
  db: KobeDb,
  now = Date.now(),
  batch = RATE_LIMIT_PRUNE_BATCH,
): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM kobe_rate_limits WHERE key IN (
        SELECT key FROM kobe_rate_limits WHERE expires_at < ${now}
        ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)`);
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "expired rate-limit rows could not be pruned");
    return 0;
  }
}
