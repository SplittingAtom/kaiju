import { agentConnectors, type AgentFrontmatter } from "@kaiju/agent-file";
import type { KaijuTx } from "@kaiju/db";
import { matchGlob } from "@kaiju/protocol";
import { type RunMcpServer } from "@kaiju/protocol/sandbox-wire";
import { allowedKaijuTools, loadKaijuAccess, loadKaijuBuiltin } from "./access.js";
import { KAIJU_DOCS_TOOLS } from "./docs/index.js";
import { allowListOffers } from "../policy/agent-allow.js";
import { kaijuPinnedTool } from "./pinned.js";

/**
 * The built-in Kaiju connector in a run's `run.start.mcp` (KOBE-619, spec §3, KA7):
 *
 * - the **docs tools** (KOBE-620) are on every run whatever the agent's connector list: runs
 *   without an agent, scheduled runs, skill evals and test chats included;
 * - the **admin tools** follow the agent's connector list (`kobe` by the row's name, or `all`),
 *   only for a run a person can answer (not scheduled, not a skill eval or test chat), only the
 *   tools the person may use now (switches and permission).
 *
 * Both are filtered by the agent's tool globs, and nothing is attached while the site switch is
 * `off` or when the owner turned the connector off for the thread. Undefined: the run gets no Kaiju
 * server. The MCP proxy's re-check decides every call again.
 */
export async function kaijuRunServer(
  tx: KaijuTx,
  run: {
    readonly teamId: string;
    readonly userId: string;
    /** A person can answer this run (user-triggered; not an eval, test chat or grantless run). */
    readonly answerable: boolean;
    /** The agent's frontmatter; undefined for a run without an agent (docs tools only). */
    readonly frontmatter: AgentFrontmatter | undefined;
    /** Connector ids the owner turned off for the thread. */
    readonly off: ReadonlySet<string>;
  },
): Promise<RunMcpServer | undefined> {
  const row = await loadKaijuBuiltin(tx);
  if (!row || run.off.has(row.id)) return undefined;
  const globs = run.frontmatter?.tools;
  const allowedByAgent = (piName: string) =>
    !(globs?.deny?.some((g) => matchGlob(g, piName)) ?? false) &&
    allowListOffers(globs?.allow, (g) => matchGlob(g, piName));
  const admin = await adminTools(tx, row.name, run);
  const tools = [...KAIJU_DOCS_TOOLS, ...admin]
    .map((t) => kaijuPinnedTool(row.name, t))
    .filter((t) => allowedByAgent(t.pi_name))
    .map((t) => ({ name: t.name, pi_name: t.pi_name }));
  return tools.length === 0 ? undefined : { name: row.name, connector_id: row.id, tools };
}

async function adminTools(tx: KaijuTx, rowName: string, run: Parameters<typeof kaijuRunServer>[1]) {
  if (!run.answerable || run.frontmatter === undefined) return [];
  const { all, names } = agentConnectors(run.frontmatter);
  if (!all && !names.includes(rowName)) return [];
  return allowedKaijuTools(await loadKaijuAccess(tx, run.teamId, run.userId));
}
