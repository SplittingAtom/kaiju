import {
  backgroundPrune,
  returnRateBucketToken,
  takeRateBucket,
  type RateBucketRule,
  type RateLimitDb,
} from "@kobe/db";

/** One request taken from a member's per-minute model rate. */
export type MemberRateTake =
  | {
      readonly ok: true;
      /** Gives the request back (the call was refused right after, by a budget). */
      readonly giveBack: () => void;
    }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/**
 * The member per-minute model rate (an admin-set Site/Workspace number, KOBE-42). Throws when the
 * count cannot be read; the gate then refuses the call (fail closed, KOBE-810).
 */
export interface MemberRate {
  take(key: string, perMinute: number): Promise<MemberRateTake>;
}

const MINUTE_MS = 60_000;

/** A bucket of `perMinute` requests refilled at perMinute/60 per second: the old shim bucket. */
export function memberRateRule(perMinute: number): RateBucketRule {
  return { burst: perMinute, perSecond: perMinute / 60 };
}

/**
 * The Postgres limiter's own connection settings in the gateway (KOBE-810): a small pool apart from
 * the gateway's main one, so a slow or saturated database refuses a model request within about
 * 2 s (acquire, then statement) instead of the main pool's 10 s acquire and 120 s statement limits.
 * Its size is `KOBE_MODEL_GATEWAY_RATE_POOL_MAX` (chart `modelGateway.database.ratePoolMax`, 2).
 */
export const MEMBER_RATE_DB = { acquireTimeoutMs: 2_000, statementTimeoutMs: 2_000 };

/**
 * Production (KOBE-810): the member's bucket in Postgres (`kobe_rate_limits`, key
 * `kobe:model-rpm:<team>:<user>`, GCRA in one atomic upsert per model request), shared by every
 * gateway replica, with the old in-memory bucket's behaviour: a burst of the per-minute value,
 * refilled at value/60 per second, refused requests not charged. A refusal's Retry-After is the
 * time until one request is available plus a jitter of up to one interval (at most 1 s), so a
 * member's throttled runs do not all retry at the same instant. Bifrost's per-key window stays as
 * the backstop. The prune of expired rows does not ride on the request (most members find their
 * bucket full again, which would add a DELETE to most calls): it runs in the background, at most
 * every 10 s per replica. Time comes from the database clock (KOBE-810: replicas with skewed clocks
 * still share one bucket), unless `now` is injected.
 */
export class DbMemberRate implements MemberRate {
  private readonly prune: (now?: number) => void;

  constructor(
    private readonly db: RateLimitDb,
    private readonly options: {
      readonly now?: () => number;
      /** In [0, 1): the jitter's share of its maximum (tests pin it). */
      readonly random?: () => number;
      /** A give-back or a prune of expired rows failed (logged; never fails the call). */
      readonly onError?: (err: unknown) => void;
    } = {},
  ) {
    this.prune = backgroundPrune(db, {
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  async take(key: string, perMinute: number): Promise<MemberRateTake> {
    const onError = this.options.onError ?? (() => undefined);
    const rowKey = `model-rpm:${key}`;
    const rule = memberRateRule(perMinute);
    const now = this.options.now?.();
    const hit = await takeRateBucket(this.db, rowKey, rule, {
      ...(now === undefined ? {} : { now }),
      prune: false,
    });
    this.prune(now);
    if (!hit.allowed) {
      const jitter =
        (this.options.random ?? Math.random)() * Math.min(1_000, MINUTE_MS / perMinute);
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((hit.retryAfterMs + jitter) / 1000)),
      };
    }
    return {
      ok: true,
      giveBack: () => {
        returnRateBucketToken(this.db, rowKey, rule).catch(onError);
      },
    };
  }
}

/**
 * This process's memory: a token bucket per member (burst = the per-minute value, refilled at
 * rpm/60 per second). Only for tests and a gate without a database; it counts per replica.
 */
export class MemoryMemberRate implements MemberRate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  take(key: string, perMinute: number): Promise<MemberRateTake> {
    const t = this.now();
    const refill = perMinute / MINUTE_MS;
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t };
    const tokens = Math.min(perMinute, b.tokens + (t - b.at) * refill);
    // Bounded: drop the least recently used member (re-inserting keeps Map order = recency).
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: t });
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / refill / 1000));
      return Promise.resolve({ ok: false, retryAfterSeconds });
    }
    this.buckets.set(key, { tokens: tokens - 1, at: t });
    return Promise.resolve({
      ok: true,
      giveBack: () => {
        const cur = this.buckets.get(key);
        if (cur) this.buckets.set(key, { ...cur, tokens: cur.tokens + 1 });
      },
    });
  }
}
