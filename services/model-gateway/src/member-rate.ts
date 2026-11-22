import { returnRateLimitHit, takeRateLimit, type KobeDb } from "@kobe/db";

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

/**
 * Production (KOBE-810): a fixed one-minute window per member in Postgres (`kobe_rate_limits`,
 * key `kobe:model-rpm:<team>:<user>`), one atomic upsert per model request, shared by every
 * gateway replica, so the admin's number holds whatever the replica count. The same window shape
 * as Bifrost's per-virtual-key limit, which stays as the backstop.
 */
export class DbMemberRate implements MemberRate {
  constructor(
    private readonly db: KobeDb,
    private readonly options: {
      readonly now?: () => number;
      /** A give-back or a prune of expired rows failed (logged; never fails the call). */
      readonly onError?: (err: unknown) => void;
    } = {},
  ) {}

  async take(key: string, perMinute: number): Promise<MemberRateTake> {
    const onError = this.options.onError ?? (() => undefined);
    const rowKey = `model-rpm:${key}`;
    const hit = await takeRateLimit(
      this.db,
      rowKey,
      { windowMs: MINUTE_MS, max: perMinute },
      { now: this.options.now?.() ?? Date.now(), onPruneError: onError },
    );
    if (!hit.allowed) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)) };
    }
    return {
      ok: true,
      giveBack: () => {
        returnRateLimitHit(this.db, rowKey, hit.windowStart).catch(onError);
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
