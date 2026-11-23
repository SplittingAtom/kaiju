import type { AuditEventDoc } from "./fragments.js";
import type { RUNS_EVENTS } from "./runs.js";

/**
 * The docs/audit-log.md rows of the runs area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in name order.
 */
export const RUNS_EVENT_DOCS = {
  "approval.consumed": {
    fields: "`approvalId`, `runId`, `toolCallId`, `tool`, `enforcementPoint` (mcp_proxy, server)",
    when: "The MCP proxy verified the signed approval and used it, once (system)",
  },
  "approval.decided": {
    fields:
      "`approvalId`, `runId`, `toolCallId`, `tool`, `decision` (allow, deny), `remember`, `ruleId?`, `approveAll?`",
    when: "The run's user allowed or denied it; `remember` wrote an allow rule (`ruleId`, also `policy.rule.created`)",
  },
  "approval.expired": {
    fields:
      "`approvalId`, `runId`, `toolCallId`, `tool`, `cause` (ttl, run_cancelled, run_interrupted, budget_exhausted, run_failed)",
    when: "A pending approval ended undecided: 1 h TTL (the run fails) or its run ended (system)",
  },
  "approval.rejected": {
    fields:
      "`runId`, `toolCallId`, `tool`, `reason`, `enforcementPoint` (mcp_proxy, server), `approvalId?`, `suppressed?`",
    when: "A call needing approval was refused: at the MCP proxy (no/tampered/replayed/expired/used approval) or at the server (replayed tool call id, per-run approval or event cap) (system; throttled per tool call and reason, `suppressed` counts repeats)",
  },
  "approval.requested": {
    fields: "`approvalId`, `runId`, `threadId`, `toolCallId`, `tool`, `risk`, `userId`",
    when: "A tool call waits for its user's approval (D29; system)",
  },
  "run.budget_stopped": {
    fields: "`runId`, `threadId`, `scope` (install, team, user)",
    when: "A run ended after its step because a budget is used up (D30; system)",
  },
  "run.cancelled": {
    fields: "`runId`, `threadId`, `wasActive`, `queuePaused?`, `reason?`",
    when: "The owner stopped a run or deleted a queued message (D17); `queuePaused: true` when the Stop paused the messages queued behind it (KOBE-26); `reason` (owner_deactivated, member_removed; system): a scheduled run cancelled because its owner was deactivated or left the team (KOBE-180)",
  },
  "run.interrupted": {
    fields: "`runId`, `threadId`, `cause` (sandbox_gone, not_resumed, pi_exited)",
    when: "The sandbox wire interrupted an active run (D14; system)",
  },
  "run.queue_paused": {
    fields: "`threadId`, `queued`",
    when: "The owner paused the queue; the `queued` messages wait until resumed (a queued Retry still runs first and is not counted; CE10, KOBE-206)",
  },
  "run.queue_reordered": {
    fields: "`threadId`, `queued`",
    when: "The owner reordered the `queued` messages waiting on the thread (CE10, KOBE-206)",
  },
  "run.queue_resumed": {
    fields: "`threadId`, `wasInterrupted`",
    when: "The owner resumed a paused queue, or chose Continue without retry on an interrupted thread (D14, KOBE-26, KOBE-206)",
  },
  "run.retried": {
    fields: "`runId` (the new run), `threadId`, `retryOfRunId`",
    when: "The owner retried an interrupted run (D14)",
  },
} satisfies Record<keyof typeof RUNS_EVENTS, AuditEventDoc>;
