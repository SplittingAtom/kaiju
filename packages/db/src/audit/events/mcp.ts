import { z } from "zod";
import { PI_TOOL_NAME_PATTERN } from "../../connectors/snapshot.js";
import { event, id, reasonCode, type AuditEventDef } from "./fragments.js";
import { APP_CALL_REASONS, MCP_APPROVAL_FAILURES } from "./vocab.js";

export const MCP_EVENTS = {
  // ── mcp: tool calls through the MCP proxy (KOBE-58, D27, D29); metadata only, never inputs ──
  /**
   * An MCP App's own `tools/call` under the viewing member's browser principal (KOBE-436, spec §6):
   * read-only, app-visible tools of the app's connector only. Every decision is recorded (denials
   * throttled per member and reason, rate-limit refusals once a minute). Never arguments, results
   * or credentials.
   */
  "mcp.app_call": event("team", {
    connectorId: id,
    userId: id,
    /** The upstream tool name (MCP grammar). */
    tool: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_.-]{1,128}$/),
    decision: z.enum(["allowed", "denied"]),
    reason: z.enum(APP_CALL_REASONS),
    /** The pinned template of the app the call came from. */
    templateSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /**
   * A rail-launched app card that waited for a run was not inserted (KOBE-440, review LOW-2): the
   * member could no longer open the app (`no_access`), it waited more than 10 minutes
   * (`expired`), it would have made too many cards in a row, or it was not a valid card.
   */
  "mcp.app_card_dropped": event("team", {
    connectorId: id,
    userId: id,
    threadId: id,
    tool: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_.-]{1,128}$/),
    reason: z.enum(["no_access", "expired", "too_many_cards", "invalid"]),
  }),
  /**
   * The server decided an MCP `tools/call` the proxy asked about (actor: the sandbox's user). Every
   * allowed call is recorded before the proxy forwards it; denied calls are throttled per sandbox.
   * `reason` is the deciding policy reason code (`approval_granted` when a signed approval was
   * verified and consumed); `approvalFailure` says why an approval did not authorise the call.
   */
  "mcp.tool_call": event("team", {
    sandboxId: id,
    userId: id,
    connectorId: id,
    /** Pi tool name (`mcp__<server>__<tool>`), policy metadata. */
    tool: z.string().max(256).regex(PI_TOOL_NAME_PATTERN),
    runId: id.optional(),
    threadId: id.optional(),
    /** Only when the client sent one in `_meta` and it is a plain id. */
    toolCallId: z
      .string()
      .regex(/^[A-Za-z0-9_.:/-]{1,128}$/)
      .optional(),
    decision: z.enum(["allowed", "denied"]),
    reason: reasonCode,
    risk: z.enum(["read", "write", "destructive"]).optional(),
    approvalId: id.optional(),
    approvalFailure: z.enum(MCP_APPROVAL_FAILURES).optional(),
    /** The member's remembered approval that allowed it (KOBE-289). */
    ruleId: id.optional(),
    /**
     * Allowed calls (KOBE-449): which credential the proxy attaches, by the connector's mode: none,
     * the member's own grant, or the KOBE-303 site-wide key. Never the key or its hint.
     */
    credential: z.enum(["none", "member", "site"]).optional(),
  }),

  /**
   * The MCP proxy asked for the tools of a connector the team has not enabled (KOBE-106); nothing
   * is listed. Throttled per sandbox like denied calls.
   */
  "mcp.list_refused": event("team", {
    sandboxId: id,
    userId: id,
    connectorId: id,
    reason: reasonCode,
  }),
} as const satisfies Record<string, AuditEventDef>;
