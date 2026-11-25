import { describe, expect, it } from "vitest";
import {
  policyDecisionSchema,
  type JsonObject,
  type PolicyDecision,
  type ToolDescriptor,
} from "@kaiju/protocol";
import {
  ENABLED_ALL,
  NOW,
  builtin,
  policyInput,
  rule,
  ruleSet,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import type { PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS } from "./settings.js";
import { stateFolderViews } from "./state-folder-views.js";

/**
 * KOBE-827: the sandbox folder moved from `/workspace/.kobe` to `/workspace/.kaiju`. A rule
 * protecting the folder under one name protects it under the other (deny, ask, `tools.deny`);
 * allow rules never stretch to the other name (remembered approvals are user allow rules: same
 * matching, `userAllow` uses the input as given).
 */
const read = builtin("read");
const bash = builtin("bash");

function decide(
  tool: ToolDescriptor,
  input: JsonObject,
  rules: readonly PolicyRule[],
  options: InputOptions = {},
): PolicyDecision {
  const decision = evaluatePolicy({
    input: policyInput(tool, input, options),
    tool,
    rules: ruleSet(rules),
    connector: ENABLED_ALL,
    settings: DEFAULT_POLICY_SETTINGS,
    now: NOW,
  });
  expect(policyDecisionSchema.parse(decision)).toEqual(decision);
  return decision;
}

describe("evaluatePolicy: the sandbox folder under its two names (KOBE-827)", () => {
  it.each(["site", "team"] as const)(
    "a %s deny on /workspace/.kobe/** still denies the moved folder, and the old one",
    (scope) => {
      const deny = rule(scope, "deny", "read", { arg_pattern: { "/path": "/workspace/.kobe/**" } });
      for (const path of [
        "/workspace/.kaiju/repos/app/.env",
        ".kaiju/repos/app/.env",
        "/workspace/.kobe/repos/app/.env",
      ]) {
        const decision = decide(read, { path }, [deny]);
        expect(decision.effect, path).toBe("deny");
        expect(decision.reasons[0]?.rule_id).toBe(deny.id);
      }
      expect(decide(read, { path: "/workspace/notes.md" }, [deny]).effect).toBe("allow");
    },
  );

  it("a deny written for the new name also covers a .kobe folder left in place", () => {
    const deny = rule("team", "deny", "read", { arg_pattern: { "/path": "/workspace/.kaiju/**" } });
    expect(decide(read, { path: "/workspace/.kobe/repos/app/.env" }, [deny]).effect).toBe("deny");
  });

  it("an ask on a command naming .kobe still asks for the same command on .kaiju", () => {
    const ask = rule("site", "ask", "bash", { arg_pattern: { "/command": "*.kobe/repos*" } });
    const decision = decide(bash, { command: "cd /workspace/.kaiju/repos/app && git push" }, [ask]);
    expect(decision.effect).toBe("require_approval");
    expect(decision.reasons.map((r) => r.code)).toContain("site_ask_rule");
  });

  it("the agent's tools.deny on the old folder applies to the new one", () => {
    const decision = decide(read, { path: "/workspace/.kaiju/sessions/t.jsonl" }, [], {
      toolsDeny: ["read:/workspace/.kobe/**"],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("agent_tool_deny");
  });

  it("allow rules never stretch to the other name", () => {
    const command = "cd /workspace/.kaiju/repos/app && git push";
    const allowListed = (written: string) =>
      rule("team", "allow", "bash", { arg_pattern: { "/command": written } });
    // Auto mode runs a write only when a team allow rule lists it.
    const old = allowListed("cd /workspace/.kobe/repos/app && git push");
    expect(decide(bash, { command }, [old], { mode: "auto" }).effect).toBe("deny");
    // Control: the same rule written for the new name does list it.
    const current = allowListed(command);
    expect(decide(bash, { command }, [current], { mode: "auto" }).effect).toBe("allow");
  });

  it("leaves inputs that name neither folder without an extra view", () => {
    expect(stateFolderViews({ path: "/workspace/notes.kobe", n: 1, list: ["a"] })).toEqual([]);
    expect(stateFolderViews({ nested: { cmd: ["ls", ".kobe"] } })).toEqual([
      { nested: { cmd: ["ls", ".kaiju"] } },
    ]);
  });
});
