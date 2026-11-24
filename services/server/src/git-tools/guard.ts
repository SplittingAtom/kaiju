import type { PolicyDecision, ToolDescriptor } from "@kaiju/protocol";
import type { KaijuDb } from "@kaiju/db";
import { GIT_BUILTIN_CONNECTOR_ID } from "@kaiju/db";
import { kaijuToolName } from "../policy/kaiju-admin-guard.js";
import { decideGitAccess, loadGitToolFacts, type GitToolPrincipal } from "./access.js";
import { gitToolByName } from "./catalog.js";

/**
 * The person-and-connection half of a git host tool decision (KOBE-762), applied after the policy
 * engine at the sandbox's `policy.check` (the MCP proxy's re-check makes the same check in
 * `kaiju-mcp/service.ts`): a malformed call, or one the connection, the member's role, the agents
 * of the sandbox's runs or the Site refuse, is denied before anyone is asked to approve it. An
 * engine deny stands; an allow or an ask otherwise passes unchanged (policy decides those).
 */
export const GIT_NOT_ALLOWED_REASON = "git_not_allowed";

/** A tool of the built-in git connector, by the server's own descriptor (never by its name alone). */
export function isGitBuiltinTool(
  tool: Pick<ToolDescriptor, "source" | "connector_id" | "name">,
): boolean {
  if (tool.source !== "mcp" || tool.connector_id !== GIT_BUILTIN_CONNECTOR_ID) return false;
  const name = kaijuToolName(tool.name);
  return name !== undefined && gitToolByName(name) !== undefined;
}

export async function guardGitToolCall(
  db: KaijuDb,
  principal: GitToolPrincipal,
  decision: PolicyDecision,
  tool: ToolDescriptor,
  input: unknown,
): Promise<PolicyDecision> {
  if (!isGitBuiltinTool(tool) || decision.effect === "deny") return decision;
  const name = kaijuToolName(tool.name);
  const def = name === undefined ? undefined : gitToolByName(name);
  const refuse = (code: "invalid_input" | typeof GIT_NOT_ALLOWED_REASON, message: string) => ({
    effect: "deny" as const,
    risk: decision.risk,
    reasons: [
      {
        code,
        stage: code === "invalid_input" ? ("site_deny" as const) : ("team_deny" as const),
        message,
      },
    ],
  });
  if (def === undefined) return refuse(GIT_NOT_ALLOWED_REASON, "Unknown git tool.");
  const parsed = def.input.safeParse(input ?? {});
  if (!parsed.success) {
    return refuse(
      "invalid_input",
      `The input of ${def.name} is not valid, so the call was denied.`,
    );
  }
  if (def.name === "git_list_connections") return decision;
  try {
    const facts = await loadGitToolFacts(db, principal);
    const connection = (parsed.data as { connection?: string }).connection;
    const decided = decideGitAccess(def, connection, facts);
    return decided.ok ? decision : refuse(GIT_NOT_ALLOWED_REASON, decided.message);
  } catch {
    return refuse(GIT_NOT_ALLOWED_REASON, "The git connection could not be checked; try again.");
  }
}
