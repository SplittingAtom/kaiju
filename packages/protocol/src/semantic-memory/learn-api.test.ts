import { describe, expect, it } from "vitest";
import {
  LEARN_REFUSAL_CODES,
  LEARN_REFUSAL_HTTP_STATUS,
  learnRefusalSchema,
  learnStartRequestSchema,
  learnStartResponseSchema,
  learnStateSchema,
} from "../index.js";

/** KOBE-395: the HTTP contract of Learn from this chat (start a pass, read the thread's state). */
const PASS = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";

describe("learn API contract (KOBE-395)", () => {
  it("defaults the start mode to new messages and takes all for a rescan", () => {
    expect(learnStartRequestSchema.parse({})).toEqual({ mode: "new" });
    expect(learnStartRequestSchema.parse({ mode: "all" }).mode).toBe("all");
    expect(learnStartRequestSchema.safeParse({ mode: "everything" }).success).toBe(false);
    expect(learnStartRequestSchema.safeParse({ mode: "new", extra: 1 }).success).toBe(false);
  });

  it("gives every refusal code an HTTP status", () => {
    for (const code of LEARN_REFUSAL_CODES)
      expect(LEARN_REFUSAL_HTTP_STATUS[code]).toBeGreaterThan(399);
    expect(LEARN_REFUSAL_HTTP_STATUS.learn_rate_limited).toBe(429);
    expect(LEARN_REFUSAL_HTTP_STATUS.thread_not_found).toBe(404);
    expect(
      learnRefusalSchema.parse({
        code: "memory_learning_model_unavailable",
        reason: "no_learning_model",
        message: "No learning model is set.",
      }).reason,
    ).toBe("no_learning_model");
  });

  it("parses a state with a running pass, waiting candidates and an estimate", () => {
    const state = learnStateSchema.parse({
      thread_id: THREAD,
      blocker: null,
      running: { pass_id: PASS, started_at: "2026-11-15T10:00:00.000Z" },
      new_messages: true,
      candidates: 3,
      passes_left: 19,
      last_failure: null,
      estimate: { new_tokens: 1200, all_tokens: 18000 },
    });
    expect(state.candidates).toBe(3);
    expect(
      learnStateSchema.safeParse({ ...state, blocker: { code: "nope", message: "x" } }).success,
    ).toBe(false);
  });

  it("parses a started pass", () => {
    expect(
      learnStartResponseSchema.parse({
        pass_id: PASS,
        run_id: PASS,
        model_alias: "k2",
        mode: "all",
        input: {
          entries: 4,
          truncated: false,
          summarised: false,
          partial: false,
          estimated_tokens: 900,
        },
      }).mode,
    ).toBe("all");
  });
});
