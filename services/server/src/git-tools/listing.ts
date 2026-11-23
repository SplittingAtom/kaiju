import {
  and,
  eq,
  readGitConnections,
  readGitSiteSettings,
  teamMembers,
  type KobeTx,
} from "@kobe/db";
import { usableConnections, type GitToolFacts } from "./access.js";
import { GIT_TOOLS, type GitToolDef } from "./catalog.js";

/**
 * Which git host tools a run is offered (KOBE-762): the read tools while the Workspace has a
 * connection the run may use at Read or above, the write tools while one is at Read and write and
 * the member is a Contributor or above (G9, G12). Not tied to the agent's connector list: every
 * member's agents get them by role (GQ8), unless the connection names chosen agents; the agent's
 * tool globs still filter them (`kobe-mcp/run.ts`). Skill evaluations and test chats get none.
 * Offering is a convenience: every call is decided again (`access.ts`).
 */
export function offeredGitTools(facts: GitToolFacts): GitToolDef[] {
  const readable = usableConnections(facts, "read").length > 0;
  if (!readable) return [];
  const writable = usableConnections(facts, "write").length > 0;
  return GIT_TOOLS.filter((t) => t.access === "read" || writable);
}

/** The git tools for a run starting now (`run.start.mcp`), from the run's own agent. */
export async function gitToolsForRun(
  tx: KobeTx,
  run: {
    readonly teamId: string;
    readonly userId: string;
    readonly agentId: string | null;
    /** False for skill evaluations, test chats and grantless runs. */
    readonly eligible: boolean;
  },
): Promise<GitToolDef[]> {
  if (!run.eligible) return [];
  const connections = await readGitConnections(tx, run.teamId);
  if (connections.length === 0) return [];
  const [member] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, run.teamId), eq(teamMembers.userId, run.userId)));
  return offeredGitTools({
    connections,
    role: member?.role ?? null,
    runAgents: [run.agentId],
    settings: await readGitSiteSettings(tx),
    evalSandbox: false,
  });
}
