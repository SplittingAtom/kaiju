import type { Context } from "hono";
import type { KaijuDb } from "@kaiju/db";
import {
  checkRateLimit,
  clearRateLimit,
  type RateLimitDb,
  type RateLimitRule,
  type RateLimitVerdict,
} from "./rate-limit.js";
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
 * other per-member Kaiju limit), per Site admin for SCIM tokens, and per client IP for the setup
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
   * Starts of an asleep sandbox the member asks for (Files panel, Refresh, context viewer): one
   * hit per start, however often the panel and the viewer ask while it comes up (see
   * {@link admitWakeStart}). A connected sandbox is not counted; a run's own wake never is.
   */
  sandboxWake: {
    bucket: "sandbox-wake",
    windowMs: 10 * MINUTE,
    max: 20,
    message: "Your sandbox was started too often. Wait a few minutes and try again.",
  },
  /**
   * Notebook cell runs the member starts (`POST /v1/threads/{id}/notebook/run`; Run all sends one
   * per cell, one after another), apart from the conversation run limit. Counted with the run
   * row, so a `thread_busy` answer (Run all's retries) does not count.
   */
  notebookRun: {
    bucket: "notebook-run",
    windowMs: MINUTE,
    max: 300,
    message: "Too many cell runs. Wait a minute and try again.",
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
  db: RateLimitDb,
  limit: OperationLimit,
  subject: string,
  now?: number,
  options: { readonly prune?: boolean } = {},
): Promise<RateLimitVerdict> {
  return checkRateLimit(db, `${limit.bucket}:${subject}`, limit, now, options);
}

/**
 * How long a counted start stays "in progress": longer than the context viewer keeps asking
 * (3 min) and than a slow volume attach. Cleared as soon as the sandbox is seen connected.
 */
export const WAKE_START_WINDOW_MS = 5 * MINUTE;

const FREE: RateLimitVerdict = { allowed: true, retryAfterSeconds: 1 };
const wakeStartKey = (owner: SandboxTarget) => `sandbox-wake-start:${owner.teamId}:${owner.userId}`;

/** A refused start, thrown to roll its transaction back (marker and hit). */
class WakeRefused extends Error {
  constructor(readonly verdict: RateLimitVerdict) {
    super("sandbox wake refused");
  }
}

/**
 * A wake of a sandbox known not to be connected (KOBE-813 review H1): the first ask starts it
 * and counts one hit of {@link OPERATION_LIMITS.sandboxWake}; asks while that start is in
 * progress (the viewer's polls, panel mounts, Refresh) are free. A marker row per (Workspace,
 * member) says a start is in progress. Marker and hit are one transaction (round 2): a refused
 * start rolls both back, and a concurrent ask waits on the marker's row lock meanwhile, then
 * finds no marker and is checked (and refused) itself; it is never let through as "in progress".
 */
export async function admitWakeStart(
  db: KaijuDb,
  owner: SandboxTarget,
  now?: number,
): Promise<RateLimitVerdict> {
  try {
    return await db.transaction(async (tx) => {
      const marker = await checkRateLimit(
        tx,
        wakeStartKey(owner),
        { windowMs: WAKE_START_WINDOW_MS, max: 1 },
        now,
        { prune: false },
      );
      if (!marker.allowed) return FREE;
      const limit = OPERATION_LIMITS.sandboxWake;
      const verdict = await admitOperation(tx, limit, owner.userId, now, { prune: false });
      if (!verdict.allowed) throw new WakeRefused(verdict);
      return verdict;
    });
  } catch (err) {
    if (err instanceof WakeRefused) return err.verdict;
    throw err;
  }
}

/** The sandbox is connected: its start is over, the next wake is a new start. */
export function wakeStartOver(db: RateLimitDb, owner: SandboxTarget): Promise<void> {
  return clearRateLimit(db, wakeStartKey(owner));
}

/**
 * A wake the member asks for (KOBE-813): free while their sandbox is connected (nothing starts),
 * else {@link admitWakeStart}. A run's own wake never comes here, so a
 * message is never refused for it: the run limit already bounds those.
 */
export async function admitSandboxWake(
  db: KaijuDb,
  router: Pick<SandboxRouter, "isConnected">,
  owner: SandboxTarget,
  now?: number,
): Promise<RateLimitVerdict> {
  if (await router.isConnected(owner).catch(() => false)) {
    await wakeStartOver(db, owner);
    return FREE;
  }
  return admitWakeStart(db, owner, now);
}

/** The standard refusal: 429 `{code: "rate_limited", message}` with `Retry-After` in seconds. */
export function rateLimited(c: Context, limit: OperationLimit, verdict: RateLimitVerdict) {
  c.header("Retry-After", String(verdict.retryAfterSeconds));
  return c.json({ code: "rate_limited", message: limit.message }, 429);
}
