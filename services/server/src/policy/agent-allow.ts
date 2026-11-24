import { BUILTIN_TOOLS, type ToolDescriptor } from "@kaiju/protocol";
import { matchSubject, splitAgentToolEntry } from "./patterns.js";

/**
 * What an agent's `tools.allow` limits (KOBE-776; owner decision, Chris 2026-11-22: "restrict
 * built-ins only if the list names one"). The one rule behind the policy engine's allow-list gate
 * (`checkAgentTools`, both enforcement points), the run start's tool lists (what Pi is offered)
 * and the frozen manifest's exclusions:
 *
 * - an empty or absent list limits nothing (the builder never writes an empty list; it drops the
 *   key, and `withKaijuDocs` keeps "empty = not narrowed");
 * - connector (MCP) tools, the Kaiju connector's included, are limited whenever the list is not
 *   empty: only those it matches;
 * - built-in tools (`BUILTIN_TOOLS`, Pi's and Kaiju's own) are limited only when the list names at
 *   least one built-in (an entry whose tool part matches a built-in name: `read`, `bas?`,
 *   `bash:ls *`, `*`); then only the built-ins it matches. A list of connector tools only, as the
 *   builder writes for a chosen connector, leaves every built-in as it was.
 */

const BUILTIN_NAMES: readonly string[] = Object.keys(BUILTIN_TOOLS).sort();

/** The entry's tool part matches this built-in name (argument shorthands keep their tool). */
function entryNames(entry: string, name: string): boolean {
  const { tool } = splitAgentToolEntry(entry);
  return tool !== "" && matchSubject(tool, name, "loosen");
}

/** Whether the list names at least one built-in tool. */
export function namesBuiltin(allow: readonly string[]): boolean {
  return allow.some((entry) => BUILTIN_NAMES.some((name) => entryNames(entry, name)));
}

/** Whether the list limits `tool` at all (it must then match one of its entries). */
export function allowListLimits(allow: readonly string[], tool: ToolDescriptor): boolean {
  if (allow.length === 0) return false;
  return tool.source === "mcp" || namesBuiltin(allow);
}

/**
 * The built-ins Pi should not be offered for this list (sorted): every built-in it doesn't name,
 * when it names one; none otherwise. Argument shorthands are decided per call by the engine.
 */
export function hiddenBuiltins(allow: readonly string[] | undefined): string[] {
  if (allow === undefined || !namesBuiltin(allow)) return [];
  return BUILTIN_NAMES.filter((name) => !allow.some((entry) => entryNames(entry, name)));
}

/** Whether a connector tool (by its `mcp__<server>__<tool>` name) passes the list, at run start. */
export function allowListOffers(
  allow: readonly string[] | undefined,
  matches: (entry: string) => boolean,
): boolean {
  return allow === undefined || allow.length === 0 || allow.some(matches);
}
