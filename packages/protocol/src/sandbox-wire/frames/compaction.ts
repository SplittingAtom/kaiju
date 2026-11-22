import { z } from "zod";
import { idSchema, uuidSchema } from "../../common.js";
import { runTokenGrantSchema } from "../../run-token.js";
import {
  branchSummaryFocusSchema,
  threadCompactFocusSchema,
  threadCompactResultShape,
} from "../../threads.js";
import { wireTraceContextSchema } from "../trace-frames.js";
import { gatewayModelSchema, modelLimitsSchema, piModelApiSchema } from "./model.js";
import { commandId, frame } from "./wire.js";

/** Compaction and branch-summary commands (KOBE-212, KOBE-542/548) and their one answer each. */

/**
 * Error codes of `thread.compact_result` (KOBE-212). `thread_busy`: the thread has an active run
 * (Pi's `compact` would abort it). `nothing_to_compact`: Pi's "Nothing to compact (session too
 * small)" or "Already compacted". `compaction_failed`: any other Pi `success:false` (message = Pi's
 * error). `model_not_configured`: no gateway model to summarize with. `runtime_tampered`
 * (KOBE-213 review): the agent found Pi's private runtime changed around the compaction and stopped
 * Pi, as for a run (the server records it as the run's failure; the member sees
 * `compaction_failed`).
 */
export const THREAD_COMPACT_WIRE_ERROR_CODES = [
  "thread_busy",
  "nothing_to_compact",
  "compaction_failed",
  "model_not_configured",
  "pi_unavailable",
  "internal",
  "runtime_tampered",
] as const;

/**
 * Sandbox -> server: the one answer to `thread.compact` (instead of `command.result`), for the same
 * `command_id`. Success carries Pi's `compact` response data in Kobe casing (Pi's `usage` and
 * `details` are dropped: the gateway meters the calls, the mirrored entry keeps `details`). Has its
 * own size entry (`SANDBOX_FRAME_MAX_BYTES_BY_TYPE`); a summary over the cap is left out.
 */
export const threadCompactResultFrameSchema = z.union([
  frame("thread.compact_result", {
    command_id: commandId,
    thread_id: uuidSchema,
    ok: z.literal(true),
    ...threadCompactResultShape,
  }),
  frame("thread.compact_result", {
    command_id: commandId,
    thread_id: uuidSchema,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(THREAD_COMPACT_WIRE_ERROR_CODES),
      message: z.string().max(2000),
    }),
  }),
]);

/**
 * Error codes of `thread.branch_summary_result` (KOBE-548, CT11). `thread_busy`: Pi is streaming or
 * compacting, or the thread has another run. `nothing_to_summarize`: the branch left has no entries
 * to summarise (Pi would only move its leaf). `summary_failed`: any other Pi or extension failure
 * (Pi's text only in the agent's log, never in `message`). `model_not_configured`: no gateway model.
 * `runtime_tampered`: as `thread.compact_result`'s.
 */
export const THREAD_BRANCH_SUMMARY_WIRE_ERROR_CODES = [
  "thread_busy",
  "nothing_to_summarize",
  "summary_failed",
  "model_not_configured",
  "pi_unavailable",
  "internal",
  "runtime_tampered",
] as const;

/** The appended `branch_summary` entry (KOBE-548): its id and the parent Pi put it under. */
export const threadBranchSummaryResultShape = {
  entry_id: idSchema,
  /** `to_entry_id`, or its parent when it is a user message (Pi's placement rule). */
  parent_id: idSchema,
};

/**
 * Sandbox -> server: the one answer to `thread.branch_summary` (instead of `command.result`), for
 * the same `command_id`. Success names the appended entry; the summary itself reaches the server as
 * the mirrored entry. Errors carry a code and a short fixed message (never Pi's text).
 */
export const threadBranchSummaryResultFrameSchema = z.union([
  frame("thread.branch_summary_result", {
    command_id: commandId,
    thread_id: uuidSchema,
    ok: z.literal(true),
    ...threadBranchSummaryResultShape,
  }),
  frame("thread.branch_summary_result", {
    command_id: commandId,
    thread_id: uuidSchema,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(THREAD_BRANCH_SUMMARY_WIRE_ERROR_CODES),
      message: z.string().max(2000),
    }),
  }),
]);

/**
 * Compact a thread's Pi session (KOBE-212, CE15; threads.ts): Pi RPC `compact` with `focus` as
 * `customInstructions`. A compaction is a run (kind compaction): the server creates it under the
 * usual lease and run-start transaction (one active run per thread, so a busy thread is refused
 * before anything is sent) and mints its token there. The summary's model calls are billed to that
 * run: the frame carries its id, model and token, all required (there is no run-less path; the
 * gateway refuses a token whose run is not active and leased). Only to agents whose hello lists
 * both `thread_compact` and `run_token`; answered by exactly one `thread.compact_result`. The
 * agent refuses `thread_busy` if the thread still has another run, and holds the token in memory
 * only, as for `run.start`.
 */
export const threadCompactFrameSchema = frame("thread.compact", {
  command_id: commandId,
  thread_id: uuidSchema,
  run_id: uuidSchema,
  focus: threadCompactFocusSchema.optional(),
  /** The compaction run's model; unlike `run.start`, gateway model and API are required. */
  model: z.strictObject({
    alias: z.string().min(1).max(128),
    gateway_model: gatewayModelSchema,
    api: piModelApiSchema,
  }),
  model_limits: modelLimitsSchema.optional(),
  /** Run-bound gateway token for `run_id` (run-token.ts), as `run.start.run_token`. */
  run_token: runTokenGrantSchema,
  /** The compaction run's trace context (KOBE-274), as `run.start.trace`. */
  trace: wireTraceContextSchema.optional(),
});

/**
 * Summarise the branch being left (KOBE-542, CT11, CT20): Pi, through Kobe's Pi extension,
 * summarises the entries between the common ancestor and `from_leaf_entry_id` and appends a
 * `branch_summary` entry whose parent is `to_entry_id`. A run of kind `branch_summary`, created and
 * delivered under the run lock exactly as `thread.compact`, so it carries the same run context.
 * Only to agents whose hello lists `thread_branch_summary` and `run_token` (KOBE-548); answered by
 * exactly one `thread.branch_summary_result`. The agent refuses `thread_busy` if Pi is not idle.
 */
export const threadBranchSummaryFrameSchema = frame("thread.branch_summary", {
  command_id: commandId,
  thread_id: uuidSchema,
  run_id: uuidSchema,
  from_leaf_entry_id: idSchema,
  to_entry_id: idSchema,
  focus: branchSummaryFocusSchema.optional(),
  model: z.strictObject({
    alias: z.string().min(1).max(128),
    gateway_model: gatewayModelSchema,
    api: piModelApiSchema,
  }),
  model_limits: modelLimitsSchema.optional(),
  run_token: runTokenGrantSchema,
  trace: wireTraceContextSchema.optional(),
});
