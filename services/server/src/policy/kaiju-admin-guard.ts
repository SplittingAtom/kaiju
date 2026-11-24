import {
  APPROVAL_TTL_MS,
  parseMcpToolName,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReason,
  type ToolDescriptor,
} from "@kaiju/protocol";
import { KAIJU_BUILTIN_CONNECTOR_ID } from "@kaiju/db";
import { isKaijuDocsToolName } from "../kaiju-mcp/docs/index.js";

/**
 * The Kaiju admin guard (KOBE-619, spec kobe-admin-mcp §6, KA2), applied after the policy engine at
 * both enforcement points (the sandbox's `policy.check` and the MCP proxy's re-check), like the
 * viewed-file guard:
 *
 * - a Kaiju admin **write** asks in every approval mode, Dangerous and remembered approvals
 *   included (their allow reasons are dropped, so neither is recorded as having applied);
 * - where nobody can be asked it is denied: `auto` here, scheduled runs and skill evals below;
 * - a Kaiju admin tool of any kind is denied in scheduled runs and skill evals (they get the docs
 *   tools only, §3);
 * - an engine deny stands as it is; reads otherwise follow the ordinary policy;
 * - the docs tools (KOBE-620, KA4) are no admin tools: the ordinary policy alone decides them, in
 *   every run (scheduled runs and evals included).
 *
 * Such an approval is never remembered (`approvals/remember-options.ts`, `approvals/decide.ts`)
 * nor approved in bulk (`approvals/approve-all.ts`). Reason codes `kobe_admin_write` and
 * `kobe_admin_not_allowed`.
 */
export const KAIJU_ADMIN_WRITE_REASON = "kobe_admin_write";
export const KAIJU_ADMIN_NOT_ALLOWED_REASON = "kobe_admin_not_allowed";

/** Why a Kaiju admin approval offers no "remember" (and refuses one). */
export const KAIJU_ADMIN_NOT_REMEMBERED =
  "Kaiju admin changes are asked every time, so this approval is never remembered.";

/** A tool of the built-in Kaiju connector, by the server's own descriptor. */
export function isKaijuTool(tool: Pick<ToolDescriptor, "source" | "connector_id">): boolean {
  return tool.source === "mcp" && tool.connector_id === KAIJU_BUILTIN_CONNECTOR_ID;
}

/** A Kaiju **admin** tool: a tool of the built-in connector other than the docs tools (KOBE-620). */
export function isKaijuAdminTool(
  tool: Pick<ToolDescriptor, "source" | "connector_id" | "name">,
): boolean {
  if (!isKaijuTool(tool)) return false;
  const name = kaijuToolName(tool.name);
  return name === undefined || !isKaijuDocsToolName(name);
}

/** The Kaiju tool's catalog name (`team_members_set_role`) from its Pi name. */
export function kaijuToolName(piName: string): string | undefined {
  return parseMcpToolName(piName)?.tool_segment;
}

/** The approval was asked by this guard. */
export function isKaijuAdminAsk(reasons: readonly { readonly code: string }[]): boolean {
  return reasons.some((r) => r.code === KAIJU_ADMIN_WRITE_REASON);
}

const ALLOW_CODES: ReadonlySet<string> = new Set([
  "user_allow_rule",
  "team_allow_rule",
  "dangerous_mode",
]);

export interface KaijuAdminGuard {
  readonly tool: ToolDescriptor;
  readonly input: PolicyInput;
  /** The run is a skill eval's (KOBE-325). */
  readonly evalRun: boolean;
  readonly now: Date;
}

function notAllowed(decision: PolicyDecision, message: string): PolicyDecision {
  return {
    effect: "deny",
    risk: decision.risk,
    reasons: [{ code: KAIJU_ADMIN_NOT_ALLOWED_REASON, stage: "team_deny", message }],
  };
}

/** The decision with the guard applied: `decision` itself for every other tool. */
export function guardKaijuAdmin(decision: PolicyDecision, g: KaijuAdminGuard): PolicyDecision {
  if (!isKaijuAdminTool(g.tool) || decision.effect === "deny") return decision;
  if (g.input.actor.kind === "schedule" || g.evalRun) {
    return notAllowed(
      decision,
      "Kaiju admin tools are not available in scheduled runs or skill evals; this call was denied.",
    );
  }
  if (g.tool.risk === "read") return decision;
  if (g.input.run.approval_mode === "auto") {
    return {
      effect: "deny",
      risk: decision.risk,
      reasons: [
        {
          code: KAIJU_ADMIN_WRITE_REASON,
          stage: "approval_mode",
          message:
            "Kaiju admin changes always need the person's approval, and this run never asks; it was denied.",
        },
      ],
    };
  }
  const ask: PolicyReason = {
    code: KAIJU_ADMIN_WRITE_REASON,
    stage: "ask_rule",
    message: "A Kaiju admin change: the person approves every one, in every approval mode.",
  };
  return {
    effect: "require_approval",
    risk: decision.risk,
    reasons: [ask, ...decision.reasons.filter((r) => !ALLOW_CODES.has(r.code))],
    expires_at: new Date(g.now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
}
