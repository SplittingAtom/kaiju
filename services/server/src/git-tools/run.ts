import type { AgentFrontmatter } from "@kobe/agent-file";
import type { KobeTx } from "@kobe/db";
import { matchGlob } from "@kobe/protocol";
import type { RunMcpServer } from "@kobe/protocol/sandbox-wire";
import { allowListOffers } from "../policy/agent-allow.js";
import { gitToolsForRun } from "./listing.js";
import { gitPinnedTool, loadGitBuiltin } from "./pinned.js";

/**
 * The built-in git connector in a run's `run.start.mcp` (KOBE-762): the git host tools the run may
 * use now (`listing.ts`: a usable connection, the member's role, the Site's Git switch), filtered
 * by the agent's tool globs. Independent of the Kobe connector and its switches (owner decision
 * 2026-11-22) and of the agent's connector list (GQ8). Undefined: no git server for the run. The
 * MCP proxy's re-check decides every call again.
 */
export async function gitRunServer(
  tx: KobeTx,
  run: {
    readonly teamId: string;
    readonly userId: string;
    readonly agentId: string | null;
    /** False for skill evaluations, test chats, single-skill and grantless runs. */
    readonly eligible: boolean;
    readonly frontmatter: AgentFrontmatter | undefined;
  },
): Promise<RunMcpServer | undefined> {
  const row = await loadGitBuiltin(tx);
  if (!row) return undefined;
  const globs = run.frontmatter?.tools;
  const allowedByAgent = (piName: string) =>
    !(globs?.deny?.some((g) => matchGlob(g, piName)) ?? false) &&
    allowListOffers(globs?.allow, (g) => matchGlob(g, piName));
  const tools = (await gitToolsForRun(tx, run))
    .map((t) => gitPinnedTool(row.name, t))
    .filter((t) => allowedByAgent(t.pi_name))
    .map((t) => ({ name: t.name, pi_name: t.pi_name }));
  return tools.length === 0 ? undefined : { name: row.name, connector_id: row.id, tools };
}
