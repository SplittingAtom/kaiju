import { describe, expect, it } from "vitest";
import { policyDecisionSchema, type PolicyDecision, type ToolDescriptor } from "@kaiju/protocol";
import {
  ENABLED_ALL,
  NOW,
  mcpTool,
  policyInput,
  rule,
  ruleSet,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import type { PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS } from "./settings.js";

/**
 * KOBE-826 review H1: a rename never widens a permission. Deny and ask rules, and the agent's
 * `tools.deny`, also match a tool under the names it had before the rename; allow rules,
 * remembered approvals and `tools.allow` never do.
 */
const docs = mcpTool("mcp__kaiju__docs_index", "read");
const comment = mcpTool("mcp__kaiju_git__git_comment", "write");
const PREVIOUS: Readonly<Record<string, readonly string[]>> = {
  mcp__kaiju__docs_index: ["mcp__kobe__docs_index"],
  mcp__kaiju_git__git_comment: ["mcp__kobe_git__git_comment"],
};

function decide(
  tool: ToolDescriptor,
  rules: readonly PolicyRule[],
  options: InputOptions = {},
  previous = true,
): PolicyDecision {
  const names = PREVIOUS[tool.name] ?? [];
  const decision = evaluatePolicy({
    input: policyInput(tool, {}, options),
    tool,
    rules: ruleSet(rules),
    connector: ENABLED_ALL,
    settings: DEFAULT_POLICY_SETTINGS,
    now: NOW,
    ...(previous ? { previousNames: names } : {}),
  });
  expect(policyDecisionSchema.parse(decision)).toEqual(decision);
  return decision;
}

describe("evaluatePolicy: rules written for a tool's pre-rename name (KOBE-826)", () => {
  it.each(["site", "team"] as const)(
    "a %s deny `mcp__kobe*` still denies Kaiju and git tools",
    (scope) => {
      for (const tool of [docs, comment]) {
        const deny = rule(scope, "deny", "mcp__kobe*");
        const decision = decide(tool, [deny]);
        expect(decision.effect, tool.name).toBe("deny");
        expect(decision.reasons[0]?.rule_id).toBe(deny.id);
        // Without the pre-rename names the glob matches nothing: this is what would widen.
        expect(decide(tool, [deny], {}, false).effect).not.toBe("deny");
      }
    },
  );

  it("an ask rule written for the old name still asks", () => {
    const ask = rule("team", "ask", "mcp__kob?__docs_*");
    const decision = decide(docs, [ask]);
    expect(decision.effect).toBe("require_approval");
    expect(decision.reasons.map((r) => r.code)).toContain("team_ask_rule");
    expect(decide(docs, [ask], {}, false).effect).toBe("allow");
  });

  it("the agent's tools.deny matches the old name too", () => {
    const decision = decide(comment, [], { toolsDeny: ["mcp__kobe_git__*"] });
    expect(decision.effect).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("agent_tool_deny");
  });

  it("allow rules, remembered approvals and tools.allow never match an old name", () => {
    // A remembered approval written under the old name (as an old pod would) lifts no prompt.
    const remembered = rule("user", "allow", "mcp__kobe_git__git_comment", {
      remember_scope: "forever",
    });
    expect(decide(comment, [remembered]).effect).toBe("require_approval");
    // A team allow under the old name allows nothing in auto mode.
    const allow = rule("team", "allow", "mcp__kobe_git__git_comment");
    expect(decide(comment, [allow], { mode: "auto" }).effect).toBe("deny");
    // tools.allow under the old name keeps the tool out (an allow list never widens by a rename).
    const limited = decide(comment, [], { toolsAllow: ["mcp__kobe_git__git_comment"] });
    expect(limited.effect).toBe("deny");
    expect(limited.reasons[0]?.code).toBe("agent_tool_deny");
  });
});
