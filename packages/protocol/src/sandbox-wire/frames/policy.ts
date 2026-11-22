import { z } from "zod";
import { approvalTokenSchema } from "../../approval.js";
import { idSchema, timestampSchema, uuidSchema } from "../../common.js";
import { frame, openCode } from "./wire.js";

/** Policy frames: the sandbox asks about a tool call, the server answers (D30, KOBE-23/36). */

/** A policy reason as the sandbox reads it: known shape, open code and stage. */
export const wirePolicyReasonSchema = z.looseObject({
  code: openCode,
  stage: openCode,
  message: z.string().max(1000),
  rule_id: uuidSchema.optional(),
});
export type WirePolicyReason = z.infer<typeof wirePolicyReasonSchema>;

/**
 * kobe-policy (Pi `tool_call` handler, verified in Pi 1.0.0: it may block with `{block, reason}`)
 * asks the server about one call. The extension blocks the call until `policy.result` arrives; a
 * lost connection or any error means block (fail closed). Parallel tool calls each get their own
 * `request_id`. `input` is the input as it will execute: kobe-policy must run after every handler
 * that mutates `event.input` (Pi lets `tool_call` handlers mutate input in place). It checks the
 * executed object as is — plain JSON only, so what it sends is what the tool reads — and
 * deep-freezes that object before asking, so the executed input is exactly the decided one. It
 * does not replace `event.input` (a re-parsed copy would be a no-op in Pi 1.0.0; KOBE-36).
 * Size: at most {@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}`["policy.check"]` (1 MiB) per frame — it
 * carries a `write`'s content as executed; a larger check closes the connection, so the sandbox
 * blocks such a call locally instead of sending it (kobe-policy caps the line it hands the agent at
 * 1 MiB − 4 KiB, leaving room for the frame envelope the agent adds; KOBE-36).
 */
export const policyCheckFrameSchema = frame("policy.check", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  parent_tool_call_id: idSchema.optional(),
  /**
   * Tool name only. Source, annotations and risk are derived by the server from its own registry
   * (tools.ts); anything else the sandbox might claim about a tool is not part of the frame.
   */
  tool: z.string().min(1).max(256),
  /** Must pass `toolInputSchema`; a failing input is a `deny` (`invalid_input`), not a frame error. */
  input: z.record(z.string(), z.json()),
});

/** The call needs a human; the extension keeps waiting (up to `expires_at`). Informational. */
export const policyPendingFrameSchema = frame("policy.pending", {
  request_id: idSchema,
  run_id: uuidSchema,
  tool_call_id: idSchema,
  approval_id: uuidSchema,
  expires_at: timestampSchema,
});

/**
 * The server's decision. Only `allow` / `deny` reach the sandbox (`require_approval` is resolved
 * server-side first). `message` becomes Pi's block reason. `approval` (optional, present when the
 * allow came from a human approval) stops at kobe-sandbox-agent: the agent strips it before the
 * decision reaches kobe-policy (KOBE-23), so the token never enters Pi or a tool. For Pi built-ins
 * and kobe tools this frame is itself the authorisation; the MCP proxy finds the approval by
 * (run_id, tool_call_id) server-side (KOBE-58), not through the sandbox.
 */
export const policyResultFrameSchema = z.union([
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("allow"),
    reasons: z.array(wirePolicyReasonSchema).min(1),
    approval: approvalTokenSchema.optional(),
  }),
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("deny"),
    reasons: z.array(wirePolicyReasonSchema).min(1),
    message: z.string().max(2000),
  }),
]);
