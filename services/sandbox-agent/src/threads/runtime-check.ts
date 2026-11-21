import path from "node:path";
import { tamperedConfig } from "../models/agent-config.js";
import type { ModelFile } from "../models/model-file.js";
import {
  MCP_AGENT_FILES,
  MCP_CONFIG_FILE,
  MCP_TOKEN_FILE,
  verifyAgentFile,
} from "../mcp/pi-mcp-config.js";
import type { MemoryContextFile } from "../memory/context-file.js";
import { AGENT_SUBDIR, piModelsStoreText, unexpectedEntries } from "../models/runtime-dir.js";
import type { SystemPromptFile } from "../pi/system-prompt-file.js";
import type { EgressTokenFile } from "../egress/egress-wiring.js";
import type { McpConfigState } from "./thread-env.js";

/** The current Pi's files as the thread holds them now (read at each step, as they may change). */
export interface RuntimeFiles {
  readonly modelFile: () => ModelFile | undefined;
  readonly egressFile: () => EgressTokenFile | undefined;
  readonly promptFile: () => SystemPromptFile | undefined;
  readonly memoryFile: () => MemoryContextFile | undefined;
  readonly mcpConfig: () => McpConfigState | undefined;
}

/**
 * The tripwire (KOBE-41 review): the private runtime directory may only hold what the agent
 * and Pi wrote, and the model file must be what the agent last wrote. Under Pi identities
 * (KOBE-71) no other thread can write it at all and nobody but the agent can write the model
 * file; what remains is this Pi's own tools writing its `agent/` dir (`settings.json`,
 * `models.json`, `SYSTEM.md`, which Pi 1.0.0 must be able to write into). Without identities a
 * sibling thread's tool could do the same. Either way such a Pi is stopped and its run fails
 * `runtime_tampered`. Checked once Pi is ready and again right before every prompt. Returns the
 * reason, or undefined. A detector, not a boundary: see docs/ledger/KOBE-71.md.
 */
export async function verifyRuntime(
  runtimeDir: string | undefined,
  files: RuntimeFiles,
): Promise<string | undefined> {
  if (runtimeDir === undefined) return undefined;
  // The agent's own pending writes first (temp file + rename), then the listing.
  if (files.modelFile() !== undefined && !(await files.modelFile()?.verify())) {
    return "the model file is not what the agent wrote";
  }
  if (files.egressFile() !== undefined && !(await files.egressFile()?.verify())) {
    return "the egress token file is not what the agent wrote";
  }
  if (files.promptFile() !== undefined && !(await files.promptFile()?.verify())) {
    return "the system prompt file is not what the agent wrote";
  }
  if (files.memoryFile() !== undefined && !(await files.memoryFile()?.verify())) {
    return "the memory context file is not what the agent wrote";
  }
  const mcp = files.mcpConfig();
  if (
    mcp !== undefined &&
    !(
      (await verifyAgentFile(mcp.agentDir, MCP_CONFIG_FILE, [mcp.config])) &&
      (await verifyAgentFile(mcp.agentDir, MCP_TOKEN_FILE, mcp.tokenTexts))
    )
  ) {
    return "the MCP config or token file is not what the agent wrote";
  }
  const unexpected = await unexpectedEntries(
    runtimeDir,
    mcp === undefined ? undefined : MCP_AGENT_FILES,
  );
  if (unexpected.length > 0) {
    return `unexpected entries in Pi's runtime directory: ${unexpected.slice(0, 5).join(", ")}`;
  }
  const changed = await tamperedConfig(path.join(runtimeDir, AGENT_SUBDIR));
  if (changed.length > 0) {
    return `${changed.join(", ")} is not what the agent wrote (KOBE-169)`;
  }
  // Pi reads its catalog store back on every refresh; an offline Pi with no dynamic provider
  // never persists an entry (the file is absent or `{}`), so any entry was planted.
  const store = await piModelsStoreText(runtimeDir);
  if (store !== null && store !== "{}") return "Pi's models-store.json holds catalog entries";
  return undefined;
}
