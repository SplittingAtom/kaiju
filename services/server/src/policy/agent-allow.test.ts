import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, builtinToolDescriptor, type ToolDescriptor } from "@kaiju/protocol";
import { allowListLimits, hiddenBuiltins, namesBuiltin } from "./agent-allow.js";
import { checkAgentTools } from "./gates.js";

/**
 * An agent's `tools.allow` (KOBE-776, owner decision 2026-11-22): it limits built-in tools only
 * when it names at least one; connector (MCP) tools whenever it is not empty. Empty = absent.
 */
const builtin = (name: string): ToolDescriptor => {
  const d = builtinToolDescriptor(name);
  if (!d) throw new Error(name);
  return d;
};
const mcp = (name: string): ToolDescriptor => ({
  name,
  source: "mcp",
  connector_id: "00000000-0000-4000-8000-0000000000c1",
  risk: "read",
  open_world: true,
  scope: "external",
});
const agent = (allow: string[]) => ({
  agent_id: null,
  version: 1,
  tools_allow: allow,
  tools_deny: [],
  dangerous_tools: [],
});
const allows = (allow: string[], tool: ToolDescriptor, input: Record<string, string> = {}) =>
  checkAgentTools(agent(allow), tool, input).length === 0;

describe("namesBuiltin", () => {
  it("is true for a built-in name, a glob over built-ins or an argument shorthand", () => {
    expect(namesBuiltin(["read"])).toBe(true);
    expect(namesBuiltin(["mcp__jira__*", "bas?"])).toBe(true);
    expect(namesBuiltin(["bash:ls *"])).toBe(true);
    expect(namesBuiltin(["*"])).toBe(true);
  });
  it("is false for connector tools only, an empty list or unmatchable entries", () => {
    expect(namesBuiltin(["mcp__jira__search", "mcp__*"])).toBe(false);
    expect(namesBuiltin([])).toBe(false);
    expect(namesBuiltin([":x", "made_up_tool"])).toBe(false);
  });
});

describe("the engine's allow-list gate", () => {
  it("a list naming only connector tools leaves built-ins and limits connector tools", () => {
    const allow = ["mcp__jira__search"];
    expect(allows(allow, builtin("bash"), { command: "rm -rf x" })).toBe(true);
    expect(allows(allow, builtin("remember"))).toBe(true);
    expect(allows(allow, mcp("mcp__jira__search"))).toBe(true);
    expect(allows(allow, mcp("mcp__jira__delete"))).toBe(false);
    expect(allows(allow, mcp("mcp__kobe__search_docs"))).toBe(false);
  });
  it("a list naming a built-in allows only the built-ins it names", () => {
    const allow = ["read", "bash:ls *", "mcp__jira__*"];
    expect(allows(allow, builtin("read"), { path: "/workspace/a" })).toBe(true);
    expect(allows(allow, builtin("bash"), { command: "ls -la" })).toBe(true);
    expect(allows(allow, builtin("bash"), { command: "rm -rf /" })).toBe(false);
    expect(allows(allow, builtin("write"), { path: "/workspace/a" })).toBe(false);
    expect(allows(allow, mcp("mcp__jira__x"))).toBe(true);
    expect(allows(allow, mcp("mcp__slack__x"))).toBe(false);
  });
  it("an empty list limits nothing", () => {
    expect(allowListLimits([], builtin("bash"))).toBe(false);
    expect(allowListLimits([], mcp("mcp__jira__x"))).toBe(false);
    expect(allows([], builtin("bash"), { command: "x" })).toBe(true);
  });
});

describe("hiddenBuiltins (what run start keeps from Pi)", () => {
  it("hides nothing unless the list names a built-in", () => {
    expect(hiddenBuiltins(undefined)).toEqual([]);
    expect(hiddenBuiltins([])).toEqual([]);
    expect(hiddenBuiltins(["mcp__jira__search"])).toEqual([]);
  });
  it("hides every built-in the list doesn't name (an argument shorthand keeps its tool)", () => {
    const hidden = hiddenBuiltins(["read", "bash:ls *"]);
    expect(hidden).not.toContain("read");
    expect(hidden).not.toContain("bash");
    expect(hidden).toContain("write");
    expect(hidden).toEqual(
      Object.keys(BUILTIN_TOOLS)
        .filter((n) => n !== "read" && n !== "bash")
        .sort(),
    );
  });
});
