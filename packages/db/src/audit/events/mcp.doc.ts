import type { AuditEventDoc } from "./fragments.js";
import type { MCP_EVENTS } from "./mcp.js";

/**
 * The docs/audit-log.md rows of the mcp area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const MCP_EVENT_DOCS = {
  "mcp.app_call": {
    fields:
      "`connectorId`, `userId`, `tool`, `decision` (allowed, denied), `reason`, `templateSha256?`",
    when: "An MCP App asked for a `tools/call` under the viewing member (KOBE-436): read-only, app-visible tools of its connector only; every decision is recorded before a call is forwarded. Never arguments, results or credentials",
  },
  "mcp.app_card_dropped": {
    fields:
      "`connectorId`, `userId`, `threadId`, `tool`, `reason` (no_access, expired, too_many_cards, invalid)",
    when: "A rail-launched app card that waited for a run was dropped at insertion instead of inserted (KOBE-440)",
  },
  "mcp.list_refused": {
    fields: "`sandboxId`, `userId`, `connectorId`, `reason`",
    when: "The MCP proxy asked to list the tools of a connector the team has not enabled; nothing is offered (KOBE-106), throttled per sandbox",
  },
  "mcp.tool_call": {
    fields:
      "`sandboxId`, `userId`, `connectorId`, `tool`, `runId?`, `threadId?`, `toolCallId?`, `decision` (allowed, denied), `reason`, `risk?`, `approvalId?`, `approvalFailure?`, `ruleId?`, `credential?` (none, member, site; allowed calls)",
    when: "The server decided an MCP `tools/call` for the MCP proxy (actor: the sandbox's user); every allowed call before it is forwarded, denials throttled per sandbox",
  },
} satisfies Record<keyof typeof MCP_EVENTS, AuditEventDoc>;
