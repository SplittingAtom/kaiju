import { appInputDigest } from "../apps/input-canonical.js";
import { modelVisible } from "../connectors/visibility.js";
import { randomUUID } from "node:crypto";
import {
  toolInputSchema,
  type JsonObject,
  type PolicyDecision,
  type PolicyReasonCode,
  type ToolDescriptor,
} from "@kaiju/protocol";
import type { PinnedTool } from "@kaiju/db";
import { logger } from "../logger.js";
import type { McpApprovalFailure } from "./approvals.js";
import {
  credentialUsed,
  describePinnedTool,
  exposedTools,
  loadTeamConnector,
  type EnabledConnector,
} from "./catalog.js";
import { decideAcrossRuns, policyInputFor, type Combined } from "./decide-policy.js";
import {
  audit,
  captureFor,
  deny,
  fallbackPiName,
  inputDigest,
  recordSkipped,
  type AuditFacts,
} from "./decide-records.js";
import type {
  McpCallDecision,
  McpCallRequest,
  McpDecideDeps,
  McpPrincipal,
} from "./decide-types.js";
import { engineForCall } from "./fan-out.js";
import { loadActiveRuns, runHasConnector, type ActiveRunContext } from "./run-context.js";
import { appliedUserRule, recordRuleApplied } from "../policy/rule-applied.js";
import { appliedDangerousMode, recordDangerousApplied } from "../policy/dangerous-mode.js";

export type {
  McpCallDecision,
  McpCallRequest,
  McpDecideDeps,
  McpPrincipal,
  McpUpstreamTarget,
} from "./decide-types.js";
export { combineDecisions } from "./decide-policy.js";
export { inputDigest } from "./decide-records.js";

/**
 * The MCP proxy's policy re-check (D27, D29 "MCP calls are enforced a second time at the MCP
 * proxy"). The proxy asks before every upstream `tools/call`; the server decides from its own
 * state only — the sandbox supplies a connector id, a tool name, the input and (as claims it must
 * prove) the thread and, optionally, the tool call id:
 *
 * 1. the connector must be enabled in the token's team and the tool must be in its pinned
 *    snapshot (`unknown_tool` otherwise; drift and exposure are the engine's gates);
 * 2. the thread must be the token user's, with an active run leased to the token's sandbox;
 * 3. the policy engine (KOBE-35) decides with `enforcement_point: "mcp_proxy"` and the team's
 *    exposure under **every** active run of the user leased to that sandbox (each with its own
 *    clamped mode, trigger and agent tool lists), combined by `combineDecisions`: the sandbox's
 *    thread claim selects whose approval may authorise, never which policy applies (review M1);
 * 4. needing approval → a signed approval for exactly the named run, tool and input must verify
 *    and be consumed (`McpApprovalVerifier`); anything else is a deny;
 * 5. the decision is audited (`mcp.tool_call`); an allowed call whose audit row cannot be written
 *    is refused. Every error is a deny.
 *
 * Audit rows, denials and capture tickets: decide-records.ts; the policy input and the combination
 * of run decisions: decide-policy.ts.
 */

/** One call being decided: its inputs, what its audit row knows so far, and its denial. */
interface Deciding {
  readonly deps: McpDecideDeps;
  readonly principal: McpPrincipal;
  readonly request: McpCallRequest;
  readonly now: () => Date;
  facts: AuditFacts | undefined;
  /** Audits (when facts are known and the throttle allows), logs and returns a deny. */
  readonly denied: (
    code: PolicyReasonCode,
    message: string,
    approvalFailure?: McpApprovalFailure,
  ) => Promise<McpCallDecision>;
}

/** A stage refused the call: this is its (already audited) answer. */
interface Denied {
  readonly denied: McpCallDecision;
}

/** What the checks before the policy engine established. */
interface Checked {
  readonly connector: EnabledConnector;
  readonly pinned: PinnedTool;
  readonly descriptor: ToolDescriptor;
  readonly input: JsonObject;
  readonly runs: readonly ActiveRunContext[];
  /** The run whose thread the sandbox named: its approvals are the ones that can authorise. */
  readonly named: ActiveRunContext;
  /** The thread the sandbox named (the named run's). */
  readonly threadId: string;
  /** The audit facts, run included. */
  readonly facts: AuditFacts;
  readonly toolCallId: string;
}

/** Decides one call; never throws (every failure is a deny). */
export async function decideMcpCall(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  request: McpCallRequest,
): Promise<McpCallDecision> {
  const mayAuditDenied = deps.mayAuditDenied ?? (() => true);
  const c: Deciding = {
    deps,
    principal,
    request,
    now: deps.now ?? (() => new Date()),
    facts: undefined,
    denied: async (code, message, approvalFailure) => {
      if (c.facts && mayAuditDenied(principal.sandboxId)) {
        try {
          await audit(deps, principal, c.facts, {
            decision: "denied",
            reason: code,
            ...(approvalFailure === undefined ? {} : { approvalFailure }),
          });
        } catch (err) {
          logger.error({ err, code }, "mcp: denied call could not be audited");
        }
      }
      logger.info(
        { sandboxId: principal.sandboxId, teamId: principal.teamId, code, approvalFailure },
        "mcp call denied",
      );
      return deny(code, message, approvalFailure);
    },
  };

  try {
    const tool = await checkTool(c);
    if ("denied" in tool) return tool.denied;
    const run = await checkRun(c, tool.connector, tool.facts);
    if ("denied" in run) return run.denied;
    const k: Checked = {
      ...tool,
      ...run,
      toolCallId: request.toolCallId ?? `mcp-proxy-${randomUUID()}`,
    };
    const decided = await decideUnderRuns(c, k);
    if ("denied" in decided) return decided.denied;
    const { combined, namedDecision } = decided;
    const approval = await approve(c, k, combined);
    if ("denied" in approval) return approval.denied;
    const applied = await recordApplied(c, k, combined, namedDecision);
    if ("denied" in applied) return applied.denied;
    return await allowCall(c, k, approval.reason, approval.approvalId, applied.ruleId);
  } catch (err) {
    logger.error(
      { err, sandboxId: principal.sandboxId },
      "mcp: call could not be decided (denied)",
    );
    return deny(
      "policy_error",
      "Policy could not be evaluated, so the call was denied. Try again.",
    );
  }
}

/** The connector is enabled, the tool pinned, approved, offered to agents and exposed. */
async function checkTool(c: Deciding): Promise<
  | Denied
  | {
      readonly connector: EnabledConnector;
      readonly pinned: PinnedTool;
      readonly descriptor: ToolDescriptor;
      readonly facts: AuditFacts;
    }
> {
  const { deps, principal, request } = c;
  const connector = await (deps.loadConnector ?? ((t, id) => loadTeamConnector(deps.db, t, id)))(
    principal.teamId,
    request.connectorId,
  );
  if (!connector) {
    // Not enabled (or not registered): the name is unknown, the refusal is still audited.
    c.facts = {
      connectorId: request.connectorId,
      piName: fallbackPiName("unknown", request.tool),
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    };
    return {
      denied: await c.denied(
        "connector_not_enabled",
        "This connector is not enabled in your team.",
      ),
    };
  }
  const pinned: PinnedTool | undefined = connector.tools.find((t) => t.name === request.tool);
  let facts: AuditFacts = {
    connectorId: connector.id,
    piName: pinned?.pi_name ?? fallbackPiName(connector.name, request.tool),
    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
  };
  c.facts = facts;
  if (!pinned) {
    return {
      denied: await c.denied(
        "unknown_tool",
        `${request.tool.slice(0, 128)} is not a pinned tool of this connector.`,
      ),
    };
  }
  const descriptor = describePinnedTool(connector.id, pinned);
  facts = { ...facts, risk: descriptor.risk };
  c.facts = facts;

  // Team exposure (KOBE-106), checked before any run is looked at and independent of the
  // engine's own gate: a drifted tool, or one the team's exposure does not include (read_only =
  // readOnlyHint tools only, so unannotated tools are out; custom = ticked tools), is refused
  // with its own reason whatever the sandbox sent.
  if (pinned.status !== "pinned") {
    return {
      denied: await c.denied(
        "tool_drifted",
        `${pinned.pi_name} changed since it was approved and is disabled until an admin re-approves it.`,
      ),
    };
  }
  // An app-only tool (KOBE-435) is not offered to agents: for Pi it does not exist.
  if (!modelVisible(pinned)) {
    return {
      denied: await c.denied(
        "unknown_tool",
        `${pinned.pi_name} is offered only to apps, not to agents.`,
      ),
    };
  }
  const refused = await deps.refuse?.(pinned, descriptor);
  if (refused !== undefined) return { denied: await c.denied(refused.code, refused.message) };
  if (!exposedTools(connector).some((t) => t.pi_name === pinned.pi_name)) {
    return {
      denied: await c.denied(
        "connector_exposure",
        `${pinned.pi_name} is not exposed to agents in your team (${connector.exposure.replace("_", "-")}).`,
      ),
    };
  }
  return { connector, pinned, descriptor, facts };
}

/** A valid input, and an active run of the named thread in this sandbox that has the connector. */
async function checkRun(
  c: Deciding,
  connector: EnabledConnector,
  toolFacts: AuditFacts,
): Promise<
  | Denied
  | {
      readonly input: JsonObject;
      readonly runs: readonly ActiveRunContext[];
      readonly named: ActiveRunContext;
      readonly threadId: string;
      readonly facts: AuditFacts;
    }
> {
  const { deps, principal, request } = c;
  const input = toolInputSchema.safeParse(request.arguments ?? {});
  if (!input.success) {
    return {
      denied: await c.denied(
        "invalid_input",
        "The tool input is not valid, so the call was denied.",
      ),
    };
  }
  const threadId = request.threadId;
  if (threadId === undefined) {
    return {
      denied: await c.denied("run_not_active", "The call names no thread, so it was denied."),
    };
  }
  const loaded = await loadActiveRuns(deps.db, deps.runContext, principal);
  if (!loaded.ok) {
    return {
      denied: await c.denied("run_not_active", "Too many active runs in this sandbox; try again."),
    };
  }
  // The run whose thread the sandbox named: its approvals are the ones that can authorise.
  const named = loaded.runs.find((r) => r.threadId === threadId);
  if (!named) {
    return {
      denied: await c.denied(
        "run_not_active",
        "No active run of this thread runs in this sandbox.",
      ),
    };
  }
  const facts: AuditFacts = { ...toolFacts, runId: named.runId };
  c.facts = facts;
  // KOBE-451 review HIGH-1: only a connector of the named run's run.start.mcp (not one the
  // owner turned off for the thread, nor one the agent doesn't name) whatever the sandbox sends.
  if (!runHasConnector(named, connector.id)) {
    return {
      denied: await c.denied(
        "connector_not_in_run",
        "This connector is not available to this run (it is off for this conversation, or the agent does not use it).",
      ),
    };
  }
  return { input: input.data, runs: loaded.runs, named, threadId, facts };
}

/**
 * A scheduled run (D32) is never asked and has no approvals: a deny, or an ask (a stricter
 * sibling run), both end the call, and it is recorded as a skipped action of the run.
 */
async function skip(
  c: Deciding,
  k: Checked,
  code: PolicyReasonCode,
  message: string,
): Promise<Denied> {
  if (k.named.trigger === "schedule") {
    await recordSkipped(
      c.deps,
      c.principal,
      k.named.runId,
      k.toolCallId,
      k.pinned.pi_name,
      k.descriptor,
      code,
    );
  }
  return { denied: await c.denied(code, message) };
}

/** The engine's decision under every active run, combined (review M1); refusals end the call. */
async function decideUnderRuns(
  c: Deciding,
  k: Checked,
): Promise<Denied | { readonly combined: Combined; readonly namedDecision: PolicyDecision }> {
  const { deps, principal } = c;
  const { named } = k;
  const engine = engineForCall(deps.policy);
  const decide = async (run: ActiveRunContext) => {
    const policyInput = policyInputFor(principal, run, k.descriptor, k.toolCallId, k.input, {
      enforcementPoint: "mcp_proxy",
      exposure: k.connector.exposure,
    });
    const decision = await engine.decide(policyInput);
    return deps.guard === undefined ? decision : deps.guard(decision, policyInput, run);
  };
  // The sandbox's claim picks the named run, but cannot pick its policy: the call is decided
  // under every distinct policy context of its active runs (review M1), bounded (fan-out.ts).
  const namedDecision = await decide(named);
  const { combined } = await decideAcrossRuns(
    { runId: named.runId, decision: namedDecision },
    k.runs,
    decide,
  );
  if (combined.effect === "deny") {
    return await skip(c, k, combined.reason.code, combined.reason.message);
  }
  if (combined.effect === "require_approval" && named.skillEval) {
    return await skip(
      c,
      k,
      "eval_run_no_prompt",
      "Skill eval runs never ask for approval; this call was denied.",
    );
  }
  if (combined.effect === "require_approval" && named.trigger === "schedule") {
    return await skip(
      c,
      k,
      "scheduled_run_no_prompt",
      "Scheduled runs only run allow-listed and read-only tools; this call was skipped.",
    );
  }
  return { combined, namedDecision };
}

/** Needing approval: a signed approval of exactly this call in the named run, consumed. */
async function approve(
  c: Deciding,
  k: Checked,
  combined: Combined,
): Promise<
  Denied | { readonly reason: PolicyReasonCode; readonly approvalId: string | undefined }
> {
  const { deps, principal, request } = c;
  let reason: PolicyReasonCode = combined.reason.code;
  let approvalId: string | undefined;
  if (combined.effect === "require_approval") {
    const approved = await deps.approvals.authorize({
      teamId: principal.teamId,
      userId: principal.userId,
      runId: k.named.runId,
      tool: k.pinned.pi_name,
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
      input: k.input,
      now: c.now(),
    });
    if (!approved.ok) {
      return {
        denied: await c.denied(
          reason,
          "This call needs your approval and no valid signed approval exists for it, so it was denied.",
          approved.reason,
        ),
      };
    }
    reason = "approval_granted";
    approvalId = approved.approvalId;
  }
  return { reason, approvalId };
}

/** A remembered approval's or a Dangerous agent's own record at this enforcement point. */
async function recordApplied(
  c: Deciding,
  k: Checked,
  combined: Combined,
  namedDecision: PolicyDecision,
): Promise<Denied | { readonly ruleId: string | undefined }> {
  const { deps, principal } = c;
  const { named } = k;
  // A remembered approval allowed it (KOBE-289): its own audit row and last use, at this
  // enforcement point too; a rule revoked since the decision denies the call.
  const rule = combined.effect === "allow" ? appliedUserRule(namedDecision) : undefined;
  // A skill eval (KOBE-325) never runs on its starter's remembered approvals: without the rule
  // the call would ask, and an eval never asks.
  if (rule !== undefined && named.skillEval) {
    return await skip(
      c,
      k,
      "eval_run_no_prompt",
      "Skill eval runs don't use your remembered approvals; this call was denied.",
    );
  }
  if (rule?.rule_id !== undefined) {
    const recorded = await recordRuleApplied(deps.db, {
      teamId: principal.teamId,
      userId: principal.userId,
      runId: named.runId,
      toolCallId: k.toolCallId,
      tool: k.pinned.pi_name,
      ruleId: rule.rule_id,
      enforcementPoint: "mcp_proxy",
      runMaxEvents: 0,
      announce: false,
    });
    if (!recorded) {
      return {
        denied: await c.denied(
          "policy_error",
          "The remembered approval for this call was revoked, so it was denied.",
        ),
      };
    }
  }

  // An admin's Dangerous agent allowed it (AC1): its own audit row at this enforcement point
  // too, before the call runs (a failed write throws: the call is denied).
  if (combined.effect === "allow" && appliedDangerousMode(namedDecision) !== undefined) {
    if (named.skillEval) {
      return await skip(
        c,
        k,
        "eval_run_no_prompt",
        "Skill eval runs never ask for approval; this call was denied.",
      );
    }
    await recordDangerousApplied(deps.db, {
      teamId: principal.teamId,
      userId: principal.userId,
      runId: named.runId,
      agentId: named.agentId,
      agentVersion: named.agentVersion,
      toolCallId: k.toolCallId,
      tool: k.pinned.pi_name,
      enforcementPoint: "mcp_proxy",
    });
  }
  return { ruleId: rule?.rule_id };
}

/** The allow: its capture ticket, its audit row first (no row, no upstream call), the answer. */
async function allowCall(
  c: Deciding,
  k: Checked,
  reason: PolicyReasonCode,
  approvalId: string | undefined,
  ruleId: string | undefined,
): Promise<McpCallDecision> {
  const { deps, principal } = c;
  const { connector, pinned, named } = k;
  const capture = await captureFor(deps, principal, {
    threadId: k.threadId,
    runId: named.runId,
    connectorId: connector.id,
    tool: pinned,
    // The capture's digest is of the canonical input (KOBE-441): the claim digests Pi's raw
    // arguments the same way, so Pi's conversions and schema defaults do not drop the app.
    inputSha256: appInputDigest(pinned.input_schema as Record<string, unknown>, k.input),
    now: c.now(),
  });
  // The record of the call comes first: no audit row, no upstream call.
  await audit(deps, principal, k.facts, {
    decision: "allowed",
    reason,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(ruleId === undefined ? {} : { ruleId }),
    credential: credentialUsed(connector),
  });
  return {
    decision: "allow",
    connector: {
      id: connector.id,
      name: connector.name,
      url: connector.url,
      auth_kind: connector.authKind,
    },
    tool: { name: pinned.name, pi_name: pinned.pi_name, model_visible: true },
    input_sha256: inputDigest(k.input),
    reason,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
    run_id: named.runId,
    tool_call_id: k.toolCallId,
    ...(capture === undefined ? {} : { app_capture: { ticket: capture } }),
  };
}
