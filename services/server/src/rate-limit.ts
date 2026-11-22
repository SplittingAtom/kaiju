import { sql, type KobeDb } from "@kobe/db";
import { logger } from "./logger.js";

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/** Expired rows one prune deletes at most (KOBE-809); the next new window goes on. */
export const RATE_LIMIT_PRUNE_BATCH = 100;

/** A hit's outcome, with when the window ends (the `Retry-After` of a refusal, KOBE-813). */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds until the current window ends, at least 1. */
  readonly retryAfterSeconds: number;
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
  return (await checkRateLimit(db, key, rule, now)).allowed;
}

/** Where a hit is counted: the pool, or an open transaction (`Pick` so a `KobeTx` fits too). */
export type RateLimitDb = Pick<KobeDb, "execute">;

/**
 * {@link hitRateLimit}, also reporting how long until the window ends (KOBE-813). Inside a
 * transaction pass `prune: false`: the hit then commits or rolls back with it (a refused
 * operation that rolls back leaves no extra count), and no prune can fail inside it.
 */
export async function checkRateLimit(
  db: RateLimitDb,
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
  options: { readonly prune?: boolean } = {},
): Promise<RateLimitVerdict> {
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
  if (count === 1 && options.prune !== false) await pruneExpiredRateLimits(db, now);
  const started = row === undefined ? now : Number(row.window_start);
  const left = Number.isFinite(started) ? started + rule.windowMs - now : rule.windowMs;
  return {
    allowed: count <= rule.max,
    retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)),
  };
}

/**
 * Deletes up to `batch` rows of `kobe_rate_limits` (counters and reset-email claims) whose window
 * ended before `now`. Rows another replica is pruning are skipped. A failure is logged, never
 * thrown: the hit it rides on has already been counted.
 */
export async function pruneExpiredRateLimits(
  db: RateLimitDb,
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

/** Forgets `key`'s window (a marker that is no longer true, KOBE-813). */
export async function clearRateLimit(db: RateLimitDb, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM kobe_rate_limits WHERE key = ${`kobe:${key}`}`);
}
