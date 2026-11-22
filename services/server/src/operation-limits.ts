import type { Context } from "hono";
import type { KobeDb } from "@kobe/db";
import { checkRateLimit, type RateLimitRule, type RateLimitVerdict } from "./rate-limit.js";
import type { SandboxRouter, SandboxTarget } from "./sandbox-wire/types.js";

/** A fixed limit on one operation: its bucket, window and the sentence a refusal shows. */
export interface OperationLimit extends RateLimitRule {
  /** Key prefix in `kobe_rate_limits`; the subject (member, admin, IP) follows a colon. */
  readonly bucket: string;
  readonly message: string;
}

const MINUTE = 60_000;

/**
 * Limits on operations that had none (KOBE-813, decided 2026-11-22; fixed in code, not
 * configurable). Counted per member across Workspaces (the key is the user id alone, as every
 * other per-member Kobe limit), per Site admin for SCIM tokens, and per client IP for the setup
 * token. Values are generous: normal use never meets them. Inventory: docs/rate-limits.md.
 */
export const OPERATION_LIMITS = {
  /**
   * Messages the member sends and Retry, across conversations. Schedules firing, skill evals and
   * other server-started runs never count and are never refused by it.
   */
  runSubmit: {
    bucket: "run-submit",
    windowMs: MINUTE,
    max: 60,
    message: "You are sending messages too fast. Wait a minute and try again.",
  },
  compact: {
    bucket: "thread-compact",
    windowMs: 10 * MINUTE,
    max: 10,
    message: "Too many compactions. Wait a few minutes and try again.",
  },
  branchSummary: {
    bucket: "branch-summary",
    windowMs: 10 * MINUTE,
    max: 10,
    message: "Too many branch summaries. Wait a few minutes and try again.",
  },
  upload: {
    bucket: "upload",
    windowMs: 10 * MINUTE,
    max: 120,
    message: "Too many uploads. Wait a few minutes and try again.",
  },
  scheduleCreate: {
    bucket: "schedule-create",
    windowMs: 60 * MINUTE,
    max: 20,
    message: "Too many new schedules. Wait a while and try again.",
  },
  /**
   * Starts of an asleep sandbox the member asks for (Files panel, Refresh, context viewer). A
   * sandbox that is already connected is not counted; a run's own wake never is.
   */
  sandboxWake: {
    bucket: "sandbox-wake",
    windowMs: 10 * MINUTE,
    max: 20,
    message: "Your sandbox was started too often. Wait a few minutes and try again.",
  },
  feedback: {
    bucket: "answer-feedback",
    windowMs: MINUTE,
    max: 60,
    message: "Too many ratings. Wait a minute and try again.",
  },
  /** Creating and rotating a provider's SCIM tokens, per Site admin. */
  scimTokenCreate: {
    bucket: "scim-token-create",
    windowMs: 60 * MINUTE,
    max: 10,
    message: "Too many SCIM tokens created. Wait a while and try again.",
  },
  /** First-run setup attempts per client IP; one shared bucket when no IP can be resolved. */
  setupAttempt: {
    bucket: "setup-attempt",
    windowMs: 10 * MINUTE,
    max: 10,
    message: "Too many setup attempts. Wait a few minutes and try again.",
  },
} as const satisfies Record<string, OperationLimit>;

/** The subject of a per-IP limit when no client IP was resolved: everyone shares it (fail closed). */
export const UNKNOWN_CLIENT = "unknown";

/** Counts one hit of `limit` for `subject` (a user id, or a client IP). */
export function admitOperation(
  db: KobeDb,
  limit: OperationLimit,
  subject: string,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  return checkRateLimit(db, `${limit.bucket}:${subject}`, limit, now);
}

/**
 * A wake the member asks for (KOBE-813): free while their sandbox is connected (nothing starts),
 * else one hit of {@link OPERATION_LIMITS.sandboxWake}. A run's own wake never comes here, so a
 * message is never refused for it: the run limit already bounds those.
 */
export async function admitSandboxWake(
  db: KobeDb,
  router: Pick<SandboxRouter, "isConnected">,
  owner: SandboxTarget,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  if (await router.isConnected(owner).catch(() => false)) {
    return { allowed: true, retryAfterSeconds: 1 };
  }
  return admitOperation(db, OPERATION_LIMITS.sandboxWake, owner.userId, now);
}

/** The standard refusal: 429 `{code: "rate_limited", message}` with `Retry-After` in seconds. */
export function rateLimited(c: Context, limit: OperationLimit, verdict: RateLimitVerdict) {
  c.header("Retry-After", String(verdict.retryAfterSeconds));
  return c.json({ code: "rate_limited", message: limit.message }, 429);
}
