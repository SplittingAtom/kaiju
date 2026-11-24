import type {
  JsonObject,
  PolicyDecision,
  PolicyInput,
  PolicyReason,
  ToolDescriptor,
} from "@kaiju/protocol";
import { appliedUserRule } from "../policy/rule-applied.js";
import type { ConnectorExposure } from "../policy/gates.js";
import { DECISION_CONCURRENCY, distinctSiblings, mapLimited } from "./fan-out.js";
import type { ActiveRunContext } from "./run-context.js";

/** Where the call is decided, and the exposure the caller claims (the engine's state also applies). */
export interface CallSite {
  readonly enforcementPoint: "sandbox" | "mcp_proxy";
  readonly exposure: ConnectorExposure;
}

/** The engine input for an MCP call under one active run, at either enforcement point. */
export function policyInputFor(
  principal: { readonly teamId: string; readonly userId: string },
  run: ActiveRunContext,
  tool: ToolDescriptor,
  toolCallId: string,
  input: JsonObject,
  site: CallSite,
): PolicyInput {
  return {
    actor: { user_id: principal.userId, kind: run.trigger },
    team_id: principal.teamId,
    agent: {
      agent_id: run.agentId,
      version: run.agentVersion,
      tools_allow: run.toolsAllow,
      tools_deny: run.toolsDeny,
      dangerous_tools: [...(run.dangerousTools ?? [])],
    },
    run: { run_id: run.runId, thread_id: run.threadId, approval_mode: run.mode },
    tool,
    tool_call_id: toolCallId,
    input,
    context: {
      enforcement_point: site.enforcementPoint,
      connector_exposure: site.exposure,
      ...(run.projectId === undefined ? {} : { project_id: run.projectId }),
    },
  };
}

export type Combined =
  | { readonly effect: "allow" | "require_approval"; readonly reason: PolicyReason }
  | { readonly effect: "deny"; readonly reason: PolicyReason };

const POLICY_ERROR: PolicyReason = {
  code: "policy_error",
  stage: "site_deny",
  message: "Policy could not be evaluated, so the call was denied.",
};

/**
 * One decision for a call that may come from any of the sandbox's active runs (review M1):
 * - the named run denies → deny (its own policy forbids it, approval or not);
 * - every run allows → allow (no run's policy asks for more);
 * - otherwise (the named run asks, or a sibling run asks or denies) → the user's signed approval
 *   of exactly this input in the named run is required. That approval is the user's consent to
 *   this exact call, whichever of their processes runs it; without one, a laxer sibling (a
 *   scheduled `auto` run, a broader allow list) can never stand in for the run that asks.
 */
export function combineDecisions(
  named: PolicyDecision,
  siblings: readonly PolicyDecision[],
): Combined {
  const first = (d: PolicyDecision) => d.reasons[0] ?? POLICY_ERROR;
  if (named.effect === "deny") return { effect: "deny", reason: first(named) };
  const strict = siblings.find((d) => d.effect !== "allow");
  if (named.effect === "allow" && strict === undefined)
    return { effect: "allow", reason: first(named) };
  return {
    effect: "require_approval",
    reason: named.effect === "require_approval" ? first(named) : first(strict ?? named),
  };
}

export interface AcrossRuns {
  readonly combined: Combined;
  /** The sibling runs' decisions, in the order decided. */
  readonly siblings: readonly PolicyDecision[];
}

/**
 * The one rule both enforcement points use for an MCP call (review M1, KOBE-777): the named run's
 * decision combined with the decisions under the sandbox's other active runs. Runs with the same
 * policy context as the named run, or as each other, are decided once (`distinctSiblings`), except
 * when a member's remembered approval decided the named run: such a rule can be bound to a thread
 * or run, so every other run is decided on its own (review S1). `named` is the named run's own
 * context when it is among `runs` (the sandbox's `policy.check` may not find it; then every other
 * run is decided). The sandbox's `policy.check` and the MCP proxy both call this with the same runs
 * (`loadActiveRuns`) and the same per-run input (`policyInputFor`), so they reach the same answer.
 */
export async function decideAcrossRuns(
  named: { readonly runId: string; readonly decision: PolicyDecision },
  runs: readonly ActiveRunContext[],
  decide: (run: ActiveRunContext) => Promise<PolicyDecision>,
): Promise<AcrossRuns> {
  const context = runs.find((r) => r.runId === named.runId);
  const others =
    appliedUserRule(named.decision) === undefined && context !== undefined
      ? distinctSiblings(context, runs)
      : runs.filter((r) => r.runId !== named.runId);
  const siblings = await mapLimited(others, DECISION_CONCURRENCY, decide);
  return { combined: combineDecisions(named.decision, siblings), siblings };
}
