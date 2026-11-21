import { createHash } from "node:crypto";
import {
  canonicalJson,
  type JsonObject,
  type PolicyReasonCode,
  type RiskClass,
  type ToolDescriptor,
} from "@kobe/protocol";
import { withTeam, type PinnedTool } from "@kobe/db";
import { appIdOf } from "../apps/app-id.js";
import { signCaptureTicket } from "../apps/capture-ticket.js";
import { recordAudit } from "../audit/record.js";
import { servedTemplateHash } from "../connectors/template-store.js";
import { logger } from "../logger.js";
import { recordSkippedActionInTx } from "../policy/skipped-actions.js";
import type { McpApprovalFailure } from "./approvals.js";
import type { McpCallDecision, McpDecideDeps, McpPrincipal } from "./decide-types.js";

/** Same grammar as the `mcp.tool_call` audit field: other ids are decided on but not recorded. */
const PLAIN_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function inputDigest(input: JsonObject): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function deny(
  code: PolicyReasonCode,
  message: string,
  approvalFailure?: McpApprovalFailure,
): Extract<McpCallDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    code,
    message: message.slice(0, 1000),
    ...(approvalFailure === undefined ? {} : { approval_failure: approvalFailure }),
  };
}

export interface AuditFacts {
  readonly connectorId: string;
  readonly piName: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly toolCallId?: string;
  readonly risk?: RiskClass;
}

export async function audit(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  facts: AuditFacts,
  outcome:
    | {
        decision: "allowed";
        reason: PolicyReasonCode;
        approvalId?: string;
        ruleId?: string;
        credential: "none" | "member" | "site";
      }
    | { decision: "denied"; reason: PolicyReasonCode; approvalFailure?: McpApprovalFailure },
): Promise<void> {
  await withTeam(deps.db, principal.teamId, (tx) =>
    recordAudit(tx, {
      action: "mcp.tool_call",
      teamId: principal.teamId,
      actor: { kind: "user", id: principal.userId },
      target: {
        sandboxId: principal.sandboxId,
        userId: principal.userId,
        connectorId: facts.connectorId,
        tool: facts.piName,
        ...(facts.runId === undefined ? {} : { runId: facts.runId }),
        ...(facts.threadId === undefined ? {} : { threadId: facts.threadId }),
        ...(facts.toolCallId !== undefined && PLAIN_ID.test(facts.toolCallId)
          ? { toolCallId: facts.toolCallId }
          : {}),
        ...(facts.risk === undefined ? {} : { risk: facts.risk }),
        decision: outcome.decision,
        reason: outcome.reason,
        ...("approvalId" in outcome && outcome.approvalId !== undefined
          ? { approvalId: outcome.approvalId }
          : {}),
        ...("approvalFailure" in outcome && outcome.approvalFailure !== undefined
          ? { approvalFailure: outcome.approvalFailure }
          : {}),
        ...("ruleId" in outcome && outcome.ruleId !== undefined ? { ruleId: outcome.ruleId } : {}),
        ...("credential" in outcome ? { credential: outcome.credential } : {}),
      },
    }),
  );
}

/** Pi's name for an unpinned upstream tool (audit only): same sanitising as Pi 1.0.0. */
export function fallbackPiName(connectorName: string, tool: string): string {
  const segment = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  return `mcp__${segment(connectorName) || "_"}__${segment(tool) || "_"}`.slice(0, 256);
}

export async function recordSkipped(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  runId: string,
  toolCallId: string,
  tool: string,
  descriptor: ToolDescriptor,
  reason: PolicyReasonCode,
): Promise<void> {
  try {
    await withTeam(deps.db, principal.teamId, (tx) =>
      recordSkippedActionInTx(tx, {
        teamId: principal.teamId,
        runId,
        toolCallId,
        tool,
        risk: descriptor.risk,
        reason,
      }),
    );
  } catch (err) {
    logger.error({ err, runId }, "mcp: skipped action could not be recorded");
  }
}

/** A capture ticket when the tool opens a pinned, approved template (KOBE-438). */
export async function captureFor(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  call: {
    readonly threadId: string;
    readonly runId: string;
    readonly connectorId: string;
    readonly tool: PinnedTool;
    readonly inputSha256: string;
    readonly now: Date;
  },
): Promise<string | undefined> {
  const uri = call.tool.ui?.resource_uri;
  if (deps.captureKey === undefined || uri === undefined) return undefined;
  const templateSha256 = await servedTemplateHash(deps.db, call.connectorId, uri);
  if (templateSha256 === undefined) return undefined;
  return signCaptureTicket(
    deps.captureKey,
    {
      teamId: principal.teamId,
      userId: principal.userId,
      sandboxId: principal.sandboxId,
      threadId: call.threadId,
      runId: call.runId,
      connectorId: call.connectorId,
      tool: call.tool.name,
      piName: call.tool.pi_name,
      inputSha256: call.inputSha256,
      templateUri: uri,
      templateSha256,
      appId: appIdOf(call.connectorId, uri),
    },
    call.now,
  );
}
