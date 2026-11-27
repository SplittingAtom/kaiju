import { z } from "zod";
import { count, event, id, toolCallId, toolName, type AuditEventDef } from "./fragments.js";
import { APPROVAL_REJECT_REASONS } from "./vocab.js";

export const RUNS_EVENTS = {
  // ── run: lifecycle metadata the server decides on its own (KOBE-24; never content) ──
  /** The wire ended an active run as interrupted (D14: sandbox or Pi lost; actor: system). */
  "run.interrupted": event("team", {
    runId: id,
    threadId: id,
    cause: z.enum(["sandbox_gone", "not_resumed", "pi_exited"]),
  }),
  /**
   * The thread owner stopped a run, or deleted a queued message (D17; KOBE-30). `queuePaused`: the
   * Stop paused the messages queued behind the run (KOBE-26).
   */
  "run.cancelled": event("team", {
    runId: id,
    threadId: id,
    wasActive: z.boolean(),
    queuePaused: z.literal(true).optional(),
    /** A scheduled run the system cancelled because its owner was deactivated or removed (KOBE-180). */
    reason: z.enum(["owner_deactivated", "member_removed"]).optional(),
  }),
  /** The owner paused the queue: `queued` messages wait until resumed; retries run anyway (KOBE-206). */
  "run.queue_paused": event("team", { threadId: id, queued: count }),
  /** The owner resumed a paused queue or chose Continue without retry (D14, KOBE-26, KOBE-206). */
  "run.queue_resumed": event("team", { threadId: id, wasInterrupted: z.boolean() }),
  /** The owner reordered the `queued` messages waiting on the thread (CE10; KOBE-206). */
  "run.queue_reordered": event("team", { threadId: id, queued: count }),
  /** The thread owner retried an interrupted run; `runId` is the new run (D14; KOBE-30). */
  "run.retried": event("team", { runId: id, threadId: id, retryOfRunId: id }),
  /** A run ended because a budget is used up, after its current step (D30; system). */
  "run.budget_stopped": event("team", {
    runId: id,
    threadId: id,
    scope: z.enum(["site", "team", "user"]),
  }),

  // ── approval: tool-call approvals (D29; KOBE-37); never the tool input or the signed token ──
  /** A tool call needs a human: an `approvals` row is pending (system; `userId` decides it). */
  "approval.requested": event("team", {
    approvalId: id,
    runId: id,
    threadId: id,
    toolCallId,
    tool: toolName,
    risk: z.enum(["read", "write", "destructive"]),
    userId: id,
  }),
  /**
   * The run's user allowed or denied a pending approval. `remember`: an allow rule was written in
   * the same transaction (its own `policy.rule.created` names it as `ruleId`).
   */
  "approval.decided": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean(),
    ruleId: id.optional(),
    /** Allowed with "Approve all waiting" (KOBE-289): one row per approval all the same. */
    approveAll: z.boolean().optional(),
  }),
  /** A pending approval ended without a decision: TTL (D29, 1 h) or its run ended (system). */
  "approval.expired": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    cause: z.enum(["ttl", "run_cancelled", "run_interrupted", "budget_exhausted", "run_failed"]),
  }),
  /** An enforcement point verified the signed approval and used it, once (system). */
  "approval.consumed": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    enforcementPoint: z.enum(["mcp_proxy", "server"]),
  }),
  /**
   * A call needing approval was refused before it could be used: at the MCP proxy (missing,
   * tampered input, replayed, other run, expired, used) or at the server (a tool call id replayed
   * in its run, the run's approval or event cap). Throttled per tool call and reason; `suppressed`
   * counts the repeats since the previous row of that key (system).
   */
  "approval.rejected": event("team", {
    runId: id,
    toolCallId,
    tool: toolName,
    reason: z.enum(APPROVAL_REJECT_REASONS),
    enforcementPoint: z.enum(["mcp_proxy", "server"]),
    approvalId: id.optional(),
    suppressed: count.optional(),
  }),

  // ── run.editor_*: the agent and the member's open code editor (KOBE-848); never paths, code or output ──
  /**
   * The agent ran the `.py` file the run's user has open in the editor (`editor_run`, after its
   * policy decision): how the execution ended (system; `userId` owns the run and the kernel).
   */
  "run.editor_run": event("team", {
    userId: id,
    threadId: id,
    runId: id,
    toolCallId,
    /** `refused`: the server ran nothing (gate, missing file, not allowed); `failed`: it could not. */
    status: z.enum(["ok", "error", "interrupted", "timeout", "restarted", "failed", "refused"]),
  }),
  /** The agent read the open file's run pane (`editor_read`): which tab, never its content (system). */
  "run.editor_read": event("team", {
    userId: id,
    threadId: id,
    runId: id,
    toolCallId,
    what: z.enum(["output", "log", "variables"]),
    /** `refused`: nothing was read (gate, rate limit, older agent); `failed`: it could not be. */
    outcome: z.enum(["ok", "refused", "failed"]),
  }),
} as const satisfies Record<string, AuditEventDef>;
