import { z } from "zod";
import { uuidSchema } from "../common.js";

/**
 * Learn from this chat over HTTP (KOBE-395; SM12, Q8): the thread author starts a learning pass
 * (`POST /v1/threads/{id}/learn`) and the composer's + button reads the thread's Learn state
 * (`GET /v1/threads/{id}/learn`): why Learn can't run, a running pass, new messages since the
 * last pass (the dot), and the candidates from this chat waiting for review (the count). The pass
 * itself is KOBE-393 (`services/server/src/memory/learn/run.ts`); its events are learning.ts's.
 */

/** `new`: what was said since the last pass (`/learn`); `all`: the whole branch (`/learn all`). */
export const LEARN_MODES = ["new", "all"] as const;
export const learnModeSchema = z.enum(LEARN_MODES);
export type LearnMode = z.infer<typeof learnModeSchema>;

export const learnStartRequestSchema = z.strictObject({
  mode: learnModeSchema.default("new"),
  /** The branch head the author is viewing (per-tab heads): another branch is refused. */
  viewed_leaf_entry_id: z.string().min(1).max(200).optional(),
});
export type LearnStartRequest = z.infer<typeof learnStartRequestSchema>;

/**
 * Why a pass can't start (the start's refusal, and the state's `blocker`). `memory_disabled` and
 * `memory_learning_model_unavailable` carry the switch or model `reason`; the message names the
 * cause and where to fix it.
 */
export const LEARN_REFUSAL_CODES = [
  "memory_disabled",
  "memory_learning_model_unavailable",
  "learn_rate_limited",
  "budget_exhausted",
  "pass_running",
  "no_completed_run",
  "thread_not_found",
  "read_only",
  "thread_in_trash",
  "test_thread",
  "break_glass",
  "not_current_branch",
  "nothing_to_learn",
] as const;
export const learnRefusalCodeSchema = z.enum(LEARN_REFUSAL_CODES);
export type LearnRefusalCode = z.infer<typeof learnRefusalCodeSchema>;

export const LEARN_REFUSAL_HTTP_STATUS = {
  memory_disabled: 403,
  memory_learning_model_unavailable: 409,
  learn_rate_limited: 429,
  budget_exhausted: 402,
  pass_running: 409,
  no_completed_run: 409,
  thread_not_found: 404,
  read_only: 403,
  thread_in_trash: 409,
  test_thread: 403,
  break_glass: 403,
  not_current_branch: 409,
  nothing_to_learn: 409,
} as const satisfies Record<LearnRefusalCode, number>;

export const learnRefusalSchema = z.strictObject({
  code: learnRefusalCodeSchema,
  /** The switch or model cause (`learn_off`, `no_learning_model`, `server_calls_off`, …). */
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  message: z.string().min(1).max(1000),
  /** The current leaf, for `not_current_branch` and `nothing_to_learn`. */
  leaf_entry_id: z.string().min(1).max(200).optional(),
});
export type LearnRefusal = z.infer<typeof learnRefusalSchema>;

const count = z.number().int().nonnegative();

export const learnStateSchema = z.strictObject({
  thread_id: uuidSchema,
  /** Why Learn can't start now; null when it can (a running pass is `running`, not a blocker). */
  blocker: learnRefusalSchema.nullable(),
  /** The thread's active pass (anyone's: one per thread), else null. */
  running: z.strictObject({ pass_id: uuidSchema, started_at: z.iso.datetime() }).nullable(),
  /** The branch moved on since the person's last completed pass here (or there was none). */
  new_messages: z.boolean(),
  /** Open candidates from this chat's passes waiting for the person's review. */
  candidates: count,
  /** Passes the person may still start in this Workspace today. */
  passes_left: count,
  /** The person's newest pass here, when it failed: its message (Try again). */
  last_failure: z
    .strictObject({
      pass_id: uuidSchema,
      message: z.string().min(1).max(2000),
      finished_at: z.iso.datetime(),
    })
    .nullable(),
  /**
   * Estimated input tokens (only with `?estimate=1`, for the tooltip): what `/learn` reads (null
   * when nothing is new) and what `/learn all` reads. Null when not asked or not computable.
   */
  estimate: z.strictObject({ new_tokens: count.nullable(), all_tokens: count }).nullable(),
});
export type LearnState = z.infer<typeof learnStateSchema>;

export const learnStartResponseSchema = z.strictObject({
  pass_id: uuidSchema,
  run_id: uuidSchema,
  model_alias: z.string().min(1),
  mode: learnModeSchema,
  /** What the pass reads: `partial` is "some earlier messages were compacted and left out". */
  input: z.strictObject({
    entries: count,
    truncated: z.boolean(),
    summarised: z.boolean(),
    partial: z.boolean(),
    estimated_tokens: count,
  }),
});
export type LearnStartResponse = z.infer<typeof learnStartResponseSchema>;
