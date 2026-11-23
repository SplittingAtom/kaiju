import { createHash } from "node:crypto";
import { z } from "zod";
import { KOBE_BUILTIN_CONNECTOR_URL, type PinnedTool } from "@kobe/db";
import type { EnabledConnector } from "../mcp/catalog.js";
import type { KobeBuiltinRow } from "./access.js";
import { zodOf, type KobeTool } from "./catalog.js";
import { KOBE_DOCS_TOOLS } from "./docs/index.js";
import { KOBE_ADMIN_TOOLS } from "./tools/index.js";
import { GIT_TOOLS, type GitToolDef } from "../git-tools/catalog.js";

/**
 * The Kobe catalog in the shape the MCP decision path already understands (KOBE-619): each tool as
 * a "pinned" tool of the built-in connector (annotations from the catalog, never drifted), and the
 * connector itself as a team connector with `custom` exposure over the tools the switches allow.
 * So `decideMcpCall` (policy engine, run checks, signed approvals, audit) decides Kobe calls with
 * no second implementation.
 *
 * The docs tools (KOBE-620, KA4/KA7) are part of it and always enabled: they hold no team or user
 * data, so neither switch beyond `off` nor the person's role gates them.
 */

/** What a pinned entry is made from: an admin tool or a docs tool. */
export type KobePinnable = Pick<KobeTool, "name" | "title" | "description" | "input"> & {
  readonly output?: KobeTool["output"] | z.ZodType;
  /** Reaches a system outside Kobe (the git host tools, KOBE-762): `openWorldHint: true`. */
  readonly openWorld?: boolean;
} & ({ readonly readOnly: true } | { readonly readOnly: false; readonly destructive: boolean });

/**
 * A git host tool (KOBE-762) as a pinned tool of the built-in connector: open world (it acts on
 * the git host), never destructive. Its descriptor is `external` like every MCP tool, so writes
 * ask by default in interactive runs (`policy/settings.ts`).
 */
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

export const GIT_PINNABLES: readonly KobePinnable[] = GIT_TOOLS.map(gitPinnable);

const schemaOf = (type: z.ZodType) =>
  z.toJSONSchema(type, { target: "draft-2020-12", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;

export function kobePinnedTool(connectorName: string, tool: KobePinnable): PinnedTool {
  const definition = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    input_schema: schemaOf(zodOf(tool.input)),
    ...(tool.output === undefined ? {} : { output_schema: schemaOf(zodOf(tool.output)) }),
  };
  return {
    ...definition,
    pi_name: `mcp__${connectorName.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.name}`,
    annotations: tool.readOnly
      ? { title: tool.title, readOnlyHint: true, openWorldHint: tool.openWorld === true }
      : {
          title: tool.title,
          readOnlyHint: false,
          destructiveHint: tool.destructive,
          openWorldHint: tool.openWorld === true,
        },
    sha256: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    status: "pinned",
  };
}

export function kobePinnedTools(connectorName: string): PinnedTool[] {
  return [...KOBE_DOCS_TOOLS, ...KOBE_ADMIN_TOOLS, ...GIT_PINNABLES].map((t) =>
    kobePinnedTool(connectorName, t),
  );
}

/**
 * The built-in as a team connector: `custom` exposure over the docs tools, the admin tools in
 * `enabled` and the git host tools (Pi names). Who may use a git tool with which connection is
 * the git tools' own check (`git-tools/access.ts`), made with the person and the sandbox.
 */
export function kobeConnector(row: KobeBuiltinRow, enabled: readonly KobeTool[]): EnabledConnector {
  const tools = kobePinnedTools(row.name);
  const allowed = new Set([...KOBE_DOCS_TOOLS, ...enabled, ...GIT_PINNABLES].map((t) => t.name));
  return {
    id: row.id,
    name: row.name,
    url: KOBE_BUILTIN_CONNECTOR_URL,
    authKind: "none",
    credentialSource: "member",
    exposure: "custom",
    enabledTools: tools.filter((t) => allowed.has(t.name)).map((t) => t.pi_name),
    tools,
  };
}
