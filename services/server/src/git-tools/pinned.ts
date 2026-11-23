import { GIT_BUILTIN_CONNECTOR_URL, sql, type KobeTx, type PinnedTool } from "@kobe/db";
import type { EnabledConnector } from "../mcp/catalog.js";
import { kobePinnedTool, type KobePinnable } from "../kobe-mcp/pinned.js";
import { GIT_TOOLS, type GitToolDef } from "./catalog.js";

/**
 * The built-in git connector (KOBE-762, owner decision 2026-11-22): the git host tools as their
 * own connector row (`builtin = 'git'`, fixed id), in the shape the MCP decision path already
 * understands, exactly as the Kobe connector's tools are (`kobe-mcp/pinned.ts`): each tool a
 * "pinned" tool from the code's catalog (never drifted), the connector a team connector with
 * `custom` exposure over every git tool. It has no switch of its own: the Site's Git switch and
 * each connection's settings are the ceiling (`access.ts`), so the Kobe MCP switch and the Kobe
 * connector's thread toggle never reach these tools.
 */

type Reader = Pick<KobeTx, "execute">;

export interface GitBuiltinRow {
  readonly id: string;
  readonly name: string;
}

/** The seeded `git` row while it is active. */
export async function loadGitBuiltin(db: Reader): Promise<GitBuiltinRow | undefined> {
  const res = await db.execute<{ id: string; name: string }>(sql`
    SELECT c.id, c.name FROM public.connectors c
     WHERE c.builtin = 'git' AND c.status = 'active' AND c.deleted_at IS NULL`);
  return res.rows[0];
}

/** A git host tool as a pinned entry: open world (it acts on the git host), never destructive. */
export function gitPinnable(tool: GitToolDef): KobePinnable {
  const common = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    input: tool.input,
    openWorld: true,
  };
  return tool.readOnly
    ? { ...common, readOnly: true }
    : { ...common, readOnly: false, destructive: false };
}

export function gitPinnedTool(connectorName: string, tool: GitToolDef): PinnedTool {
  return kobePinnedTool(connectorName, gitPinnable(tool));
}

export function gitPinnedTools(connectorName: string): PinnedTool[] {
  return GIT_TOOLS.map((t) => gitPinnedTool(connectorName, t));
}

/** The built-in as a team connector: `custom` exposure over every git tool. */
export function gitConnector(row: GitBuiltinRow): EnabledConnector {
  const tools = gitPinnedTools(row.name);
  return {
    id: row.id,
    name: row.name,
    url: GIT_BUILTIN_CONNECTOR_URL,
    authKind: "none",
    credentialSource: "member",
    exposure: "custom",
    enabledTools: tools.map((t) => t.pi_name),
    tools,
  };
}
