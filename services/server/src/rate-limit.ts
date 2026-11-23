import {
  RATE_LIMIT_PRUNE_BATCH,
  backgroundPrune,
  clearRateLimit,
  hitRateLimitWindow,
  pruneExpiredRateLimits as pruneRows,
  takeRateBucket,
  type KobeDb,
  type RateBucketRule,
  type RateLimitDb,
  type RateLimitRule,
} from "@kobe/db";
import { logger } from "./logger.js";

/*
 * The server's view of Kobe's durable rate limiters. The SQL lives only in `@kobe/db`
 * (`packages/db/src/rate-limit.ts`, KOBE-810), which the model gateway shares; these wrappers add
 * the server's logging of failed prunes.
 */
export {
  RATE_LIMIT_PRUNE_BATCH,
  clearRateLimit,
  type RateBucketRule,
  type RateLimitDb,
  type RateLimitRule,
};

const logPruneError = (err: unknown): void =>
  logger.warn({ err }, "expired rate-limit rows could not be pruned");

/**
 * Counts one hit against `key` in a fixed window and says whether it is within the limit: one
 * atomic upsert on `kobe_rate_limits` (keys start with "kobe:"), seen by every replica; not Better
 * Auth's `rate_limits`, which the library prunes of every row older than its own 60 s window
 * (KOBE-809). A hit that starts a new window also deletes up to {@link RATE_LIMIT_PRUNE_BATCH}
 * expired rows. Time is the database clock unless `now` is given (KOBE-810: replicas with skewed
 * clocks share one window).
 */
export async function hitRateLimit(
  db: RateLimitDb,
  key: string,
  rule: RateLimitRule,
  now?: number,
): Promise<boolean> {
  return hitRateLimitWindow(db, key, rule, {
    ...(now === undefined ? {} : { now }),
    onPruneError: logPruneError,
  });
}

/**
 * Deletes up to `batch` expired rows of `kobe_rate_limits` (counters, full buckets and reset-email
 * claims). A failure is logged, never thrown.
 */
export async function pruneExpiredRateLimits(
  db: RateLimitDb,
  now?: number,
  batch = RATE_LIMIT_PRUNE_BATCH,
): Promise<number> {
  return pruneRows(db, now, batch, logPruneError);
}

/**
 * A per-key refilling bucket counted in Postgres (GCRA), exact across server replicas and with
 * the behaviour of the in-memory bucket it replaced (KOBE-810). Time is the database clock unless
 * a clock is injected (tests); expired rows are pruned in the background, at most every 10 s per
 * limit, never on the request.
 */
export interface SharedRateLimit {
  /** Takes one request for `key`; true when admitted. Throws when Postgres is down. */
  allow(key: string): Promise<boolean>;
  /** Forgets `key`'s bucket (tests start each case from a full burst). */
  reset(key: string): Promise<void>;
}

/** A {@link SharedRateLimit} whose keys are `<name>:<key>`. */
export function sharedRateLimit(
  db: KobeDb,
  name: string,
  rule: RateBucketRule,
  clock?: () => number,
): SharedRateLimit {
  const prune = backgroundPrune(db, { onError: logPruneError });
  return {
    allow: async (key) => {
      const now = clock?.();
      const hit = await takeRateBucket(db, `${name}:${key}`, rule, {
        ...(now === undefined ? {} : { now }),
        prune: false,
      });
      prune(now);
      return hit.allowed;
    },
    reset: (key) => clearRateLimit(db, `${name}:${key}`),
  };
}
