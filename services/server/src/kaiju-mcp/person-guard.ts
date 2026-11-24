import type { PolicyDecision, ToolDescriptor } from "@kaiju/protocol";
import { withTeam, type KaijuDb } from "@kaiju/db";
import {
  isKaijuAdminTool,
  KAIJU_ADMIN_NOT_ALLOWED_REASON,
  kaijuToolName,
} from "../policy/kaiju-admin-guard.js";
import { loadKaijuAccess, personAllows, switchesAllow } from "./access.js";
import { kaijuToolByName } from "./tools/index.js";

/**
 * The person half of a Kaiju admin decision (KOBE-619, §8 "a tool hidden from tools/list is refused
 * on call too"): the run's user must hold the tool's console permission and the site and team
 * switches must allow it, re-read now. Used by the sandbox's `policy.check`, so a member is never
 * asked to approve a change their role cannot make; the MCP proxy's re-check does the same in
 * `kaiju-mcp/service.ts`. Any failure is a deny.
 */
export async function kaijuToolAllowedFor(
  db: KaijuDb,
  teamId: string,
  userId: string,
  piName: string,
): Promise<boolean> {
  const tool = kaijuToolOf(piName);
  if (tool === undefined) return false;
  const access = await withTeam(db, teamId, (tx) => loadKaijuAccess(tx, teamId, userId));
  return switchesAllow(tool, access) && personAllows(tool, access);
}

function kaijuToolOf(piName: string) {
  const name = kaijuToolName(piName);
  return name === undefined ? undefined : kaijuToolByName(name);
}

export async function guardKaijuAdminCall(
  db: KaijuDb,
  who: { readonly teamId: string; readonly userId: string },
  decision: PolicyDecision,
  tool: ToolDescriptor,
  /** The call's input as the sandbox sent it: checked against the tool's strict schema. */
  input: unknown,
): Promise<PolicyDecision> {
  // The docs tools (KOBE-620) need no permission: the ordinary policy decided them.
  if (!isKaijuAdminTool(tool) || decision.effect === "deny") return decision;
  // A malformed call is refused before anyone is asked to approve it (review L4).
  const def = kaijuToolOf(tool.name);
  if (def !== undefined && !def.input.safeParse(input ?? {}).success) {
    return {
      effect: "deny",
      risk: decision.risk,
      reasons: [
        {
          code: "invalid_input",
          stage: "site_deny",
          message: `The input of ${tool.name} is not valid, so the call was denied.`,
        },
      ],
    };
  }
  const allowed = await kaijuToolAllowedFor(db, who.teamId, who.userId, tool.name).catch(
    () => false,
  );
  if (allowed) return decision;
  return {
    effect: "deny",
    risk: decision.risk,
    reasons: [
      {
        code: KAIJU_ADMIN_NOT_ALLOWED_REASON,
        stage: "team_deny",
        message: `${tool.name} is not available to you in this team (your role, or the Kaiju admin switches); it was denied.`,
      },
    ],
  };
}
