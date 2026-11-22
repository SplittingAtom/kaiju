import { createHmac } from "node:crypto";
import { and, gt, kobeRateLimits, sql, type KobeDb } from "@kobe/db";
import { clearRateLimits, countRateLimitHit, refundRateLimitHit } from "../rate-limit.js";

/**
 * The per-account sign-in throttle (KOBE-812, decided by the owner 2026-11-22): failed password and
 * second-factor attempts are counted per account across every client address. After
 * {@link SIGN_IN_THROTTLE}.failures in a window the account gets one attempt per interval until the
 * window passes: a growing delay, never a lockout. Fixed values, not configurable.
 */
export const SIGN_IN_THROTTLE = {
  failures: 10,
  windowMs: 15 * 60_000,
  intervalMs: 60_000,
} as const;

/** What the throttled answer says (Better Auth's own rate-limit wording, same 429 shape). */
export const THROTTLED_MESSAGE = "Too many requests. Please try again later.";

/**
 * The email as Better Auth looks the account up (`email.toLowerCase()` in sign-in/email), so every
 * spelling of one address shares one counter.
 */
export function normalizeSignInEmail(email: string): string {
  return email.toLowerCase();
}

/**
 * The counter's name for an address: a keyed hash (HMAC-SHA-256 with the auth secret) of the
 * normalized email, the same whether or not an account has it. The table holds no address, and
 * without the secret nobody can tell from the keys which addresses were tried.
 */
export function signInAccountKey(secret: string, email: string): string {
  return createHmac("sha256", secret)
    .update(`kobe-sign-in-throttle\u0000${normalizeSignInEmail(email)}`)
    .digest("base64url");
}

const failuresKey = (account: string) => `sign-in-fail:${account}`;
const slotKey = (account: string) => `sign-in-slot:${account}`;
const MARKER_PREFIX = "sign-in-throttled:";
const markerKey = (userId: string) => `${MARKER_PREFIX}${userId}`;

/** An attempt let through: its reservation, to settle once the outcome is known. */
export interface SignInAttempt {
  readonly allowed: true;
  /** Attempts counted in this window, this one included. */
  readonly count: number;
  readonly windowStart: number;
}

export type SignInVerdict =
  SignInAttempt | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface ThrottledAccount {
  readonly userId: string;
  /** When the failure window ends (epoch ms) and attempts stop being spaced out. */
  readonly until: number;
}

export interface SignInThrottle {
  /**
   * Reserves one attempt for the account before its secret is checked (atomic: parallel guesses
   * can't all slip in under the threshold). Over the threshold, one attempt per interval passes;
   * the rest are refused with a retry hint and never reach the password check.
   */
  begin(account: string): Promise<SignInVerdict>;
  /**
   * The attempt failed (wrong password or code). When it is the one that reaches the threshold the
   * interval slot is taken, so the next attempt waits. Answers when the throttle ends if the
   * account is now throttled, else null.
   */
  failed(account: string, attempt: SignInAttempt): Promise<number | null>;
  /** The attempt was not a failure after all (a correct password, a malformed request): refund. */
  refund(account: string, attempt: SignInAttempt): Promise<void>;
  /** A successful sign-in or a password reset: the account's counters and Site notice go. */
  clear(account: string, userId?: string): Promise<void>;
  /**
   * Records that the user's account is throttled until `until`; true only for the first call of a
   * window (the audit event is written once per window, not per attempt).
   */
  markThrottled(userId: string, until: number): Promise<boolean>;
  /** Accounts throttled now, for the Site console. */
  throttled(): Promise<readonly ThrottledAccount[]>;
}

export function createSignInThrottle(o: {
  readonly db: KobeDb;
  readonly now?: () => number;
}): SignInThrottle {
  const { db } = o;
  const now = o.now ?? Date.now;
  const { failures, windowMs, intervalMs } = SIGN_IN_THROTTLE;

  return {
    async begin(account) {
      const t = now();
      const hit = await countRateLimitHit(db, failuresKey(account), { windowMs }, t);
      if (hit.count <= failures) return { allowed: true, ...hit };
      // Throttled: one attempt per interval, the first taken when the threshold was crossed
      // (`failed` seeds it), so the eleventh guess waits too.
      const slot = await countRateLimitHit(db, slotKey(account), { windowMs: intervalMs }, t);
      if (slot.count <= 1) return { allowed: true, ...hit };
      const next = Math.min(hit.windowStart + windowMs, slot.windowStart + intervalMs);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((next - t) / 1000)) };
    },

    async failed(account, attempt) {
      if (attempt.count < failures) return null;
      if (attempt.count === failures) {
        await countRateLimitHit(db, slotKey(account), { windowMs: intervalMs }, now());
      }
      return attempt.windowStart + windowMs;
    },

    async refund(account, attempt) {
      await refundRateLimitHit(db, failuresKey(account), attempt.windowStart);
    },

    async clear(account, userId) {
      await clearRateLimits(db, [
        failuresKey(account),
        slotKey(account),
        ...(userId ? [markerKey(userId)] : []),
      ]);
    },

    async markThrottled(userId, until) {
      const t = now();
      const result = await db.execute(sql`
        INSERT INTO kobe_rate_limits AS r (key, count, window_start, expires_at)
        VALUES (${`kobe:${markerKey(userId)}`}, 1, ${t}, ${until})
        ON CONFLICT (key) DO UPDATE SET count = 1, window_start = ${t}, expires_at = ${until}
        WHERE r.expires_at <= ${t}
        RETURNING key`);
      return (result.rowCount ?? result.rows.length) > 0;
    },

    async throttled() {
      const rows = await db
        .select({ key: kobeRateLimits.key, until: kobeRateLimits.expiresAt })
        .from(kobeRateLimits)
        .where(
          and(
            sql`${kobeRateLimits.key} LIKE ${`kobe:${MARKER_PREFIX}%`}`,
            gt(kobeRateLimits.expiresAt, now()),
          ),
        );
      return rows.map((r) => ({
        userId: r.key.slice(`kobe:${MARKER_PREFIX}`.length),
        until: Number(r.until),
      }));
    },
  };
}
