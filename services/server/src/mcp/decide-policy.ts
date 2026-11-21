import type {
  JsonObject,
  PolicyDecision,
  PolicyInput,
  PolicyReason,
  ToolDescriptor,
} from "@kobe/protocol";
import type { TeamConnector } from "./catalog.js";
import type { McpPrincipal } from "./decide-types.js";
import type { ActiveRunContext } from "./run-context.js";

export function policyInputFor(
  principal: McpPrincipal,
  run: ActiveRunContext,
  tool: ToolDescriptor,
  toolCallId: string,
  input: JsonObject,
  connector: TeamConnector,
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
      enforcement_point: "mcp_proxy",
      connector_exposure: connector.exposure,
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
