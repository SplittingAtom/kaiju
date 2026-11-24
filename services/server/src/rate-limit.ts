import {
  RATE_LIMIT_PRUNE_BATCH,
  backgroundPrune,
  clearRateLimit,
  clearRateLimits,
  hitRateLimitWindow,
  pruneExpiredRateLimits as pruneRows,
  refundRateLimitHit,
  takeRateBucket,
  takeRateLimit,
  type KaijuDb,
  type RateBucketRule,
  type RateLimitDb,
  type RateLimitRule,
} from "@kaiju/db";
import { logger } from "./logger.js";

/*
 * The server's view of Kaiju's durable rate limiters. The SQL lives only in `@kaiju/db`
 * (`packages/db/src/rate-limit.ts`, KOBE-810), which the model gateway shares; these wrappers add
 * the server's logging of failed prunes.
 */
export {
  RATE_LIMIT_PRUNE_BATCH,
  clearRateLimit,
  clearRateLimits,
  refundRateLimitHit,
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

/** One counter as a hit left it: hits in the window so far and when the window began (epoch ms). */
export interface RateLimitHit {
  readonly count: number;
  readonly windowStart: number;
}

/**
 * {@link hitRateLimit}, answering the counter itself: callers that need more than "within the
 * limit" (the sign-in throttle's threshold and retry hint, KOBE-812). `rule.max` is not used.
 * The throttle passes its own clock (its other statements use it too).
 */
export async function countRateLimitHit(
  db: RateLimitDb,
  key: string,
  rule: Pick<RateLimitRule, "windowMs">,
  now?: number,
): Promise<RateLimitHit> {
  const hit = await takeRateLimit(
    db,
    key,
    { windowMs: rule.windowMs, max: Number.MAX_SAFE_INTEGER },
    { ...(now === undefined ? {} : { now }), onPruneError: logPruneError },
  );
  return { count: hit.count, windowStart: hit.windowStart };
}

/** A hit's outcome, with when the window ends (the `Retry-After` of a refusal, KOBE-813). */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds until the current window ends, at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * {@link hitRateLimit}, also reporting how long until the window ends (KOBE-813). Inside a
 * transaction pass `prune: false`: the hit then commits or rolls back with it (a refused
 * operation that rolls back leaves no extra count), and no prune can fail inside it. Time is the
 * database clock unless `now` is given.
 */
export async function checkRateLimit(
  db: RateLimitDb,
  key: string,
  rule: RateLimitRule,
  now?: number,
  options: { readonly prune?: boolean } = {},
): Promise<RateLimitVerdict> {
  const hit = await takeRateLimit(db, key, rule, {
    ...(now === undefined ? {} : { now }),
    ...(options.prune === undefined ? {} : { prune: options.prune }),
    onPruneError: logPruneError,
  });
  return {
    allowed: hit.allowed,
    retryAfterSeconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
  };
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
  db: KaijuDb,
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
