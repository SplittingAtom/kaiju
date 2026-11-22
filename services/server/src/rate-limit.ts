import {
  RATE_LIMIT_PRUNE_BATCH,
  sql,
  hitRateLimitWindow,
  pruneExpiredRateLimits as pruneRows,
  type KobeDb,
  type RateLimitRule,
} from "@kobe/db";
import { logger } from "./logger.js";

export { RATE_LIMIT_PRUNE_BATCH, type RateLimitRule };

const logPruneError = (err: unknown): void =>
  logger.warn({ err }, "expired rate-limit rows could not be pruned");

/**
 * Counts one hit against `key` in a fixed window and says whether it is within the limit. The
 * limiter lives in `@kobe/db` (`takeRateLimit`, KOBE-810) so the model gateway shares it: one
 * atomic upsert on `kobe_rate_limits` (keys start with "kobe:"), seen by every replica; not Better
 * Auth's `rate_limits`, which the library prunes of every row older than its own 60 s window
 * (KOBE-809). A hit that starts a new window also deletes up to {@link RATE_LIMIT_PRUNE_BATCH}
 * expired rows.
 */
export async function hitRateLimit(
  db: KobeDb,
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): Promise<boolean> {
  return hitRateLimitWindow(db, key, rule, { now, onPruneError: logPruneError });
}

/**
 * Deletes up to `batch` expired rows of `kobe_rate_limits` (counters and reset-email claims). A
 * failure is logged, never thrown.
 */
export async function pruneExpiredRateLimits(
  db: KobeDb,
  now = Date.now(),
  batch = RATE_LIMIT_PRUNE_BATCH,
): Promise<number> {
  return pruneRows(db, now, batch, logPruneError);
}

/** A per-key limit counted in Postgres, exact across server replicas (KOBE-810). */
export interface SharedRateLimit {
  /** Counts one hit for `key`; true when it is within the limit. Throws when Postgres is down. */
  allow(key: string): Promise<boolean>;
  /** Forgets every counter of this limit (tests start each case from an empty window). */
  reset(): Promise<void>;
}

/** A {@link SharedRateLimit} whose keys are `<name>:<key>`. */
export function sharedRateLimit(db: KobeDb, name: string, rule: RateLimitRule): SharedRateLimit {
  return {
    allow: (key) => hitRateLimit(db, `${name}:${key}`, rule),
    reset: async () => {
      await db.execute(
        sql`DELETE FROM kobe_rate_limits WHERE starts_with(key, ${`kobe:${name}:`})`,
      );
    },
  };
}
