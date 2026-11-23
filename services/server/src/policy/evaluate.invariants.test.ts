import { describe, expect, it } from "vitest";
import { APPROVAL_MODES, BUILTIN_TOOLS, type ToolDescriptor } from "@kobe/protocol";
import {
  builtin,
  ENABLED_ALL,
  mcpTool,
  NOW,
  policyInput,
  rule,
  ruleSet,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import type { PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS } from "./settings.js";
import { run, jiraCreate, jiraSearch, PROMPT_SANDBOX } from "./evaluate.test-helpers.js";

/** One scoped allow rule per known tool (blanket `*` allow rules are not allowed). */
function allowEverything(scope: "team" | "user"): PolicyRule[] {
  return [
    ...Object.keys(BUILTIN_TOOLS).map((name) => rule(scope, "allow", name)),
    rule(scope, "allow", "mcp__jira__create_issue"),
    rule(scope, "allow", "mcp__jira__search"),
    rule(scope, "allow", "mcp__fs__delete"),
  ];
}

describe("evaluatePolicy: invariants over every combination", () => {
  const tools: ToolDescriptor[] = [
    ...Object.keys(BUILTIN_TOOLS).map((n) => builtin(n)),
    jiraCreate,
    jiraSearch,
    mcpTool("mcp__fs__delete", "destructive"),
  ];
  const ruleSets: PolicyRule[][] = [
    [],
    [rule("site", "ask", "*")],
    [rule("team", "ask", "*")],
    allowEverything("user"),
    [...allowEverything("team"), rule("team", "ask", "mcp__*")],
    [rule("site", "deny", "bash"), ...allowEverything("user")],
  ];
  const combos = APPROVAL_MODES.flatMap((mode) =>
    (["user", "schedule"] as const).flatMap((kind) =>
      [DEFAULT_POLICY_SETTINGS, PROMPT_SANDBOX].flatMap((settings) =>
        ruleSets.flatMap((rules) => tools.map((tool) => ({ mode, kind, settings, rules, tool }))),
      ),
    ),
  );

  it(`auto mode and scheduled runs never return require_approval (${combos.length} combinations)`, () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: c.rules,
        settings: c.settings,
      });
      if (c.mode === "auto" || c.kind === "schedule") {
        expect(decision.effect, `${c.mode}/${c.kind}/${c.tool.name}`).not.toBe("require_approval");
      }
    }
  });

  it("a site deny always denies, whatever else applies", () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: [...c.rules, rule("site", "deny", "*")],
        settings: c.settings,
      });
      expect(decision.effect).toBe("deny");
      expect(decision.reasons[0]?.code).toBe("site_deny_rule");
    }
  });

  it("an ask rule never yields allow, whatever allow rules exist", () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: [...c.rules, rule("team", "ask", "*"), ...allowEverything("user")],
        settings: c.settings,
      });
      expect(decision.effect).not.toBe("allow");
    }
  });

  it("a team allow rule never lifts a prompt in an interactive run (D6)", () => {
    for (const c of combos.filter((x) => x.mode !== "auto" && x.kind === "user")) {
      const args = { tool: c.tool, options: { mode: c.mode, kind: c.kind }, settings: c.settings };
      const without = run({ ...args, rules: [] });
      const withTeamAllow = run({ ...args, rules: allowEverything("team") });
      expect(withTeamAllow.effect, `${c.mode}/${c.tool.name}`).toBe(without.effect);
    }
  });

  it("in ask-all, only a user allow rule turns a prompt into allow", () => {
    for (const c of combos.filter((x) => x.mode === "ask-all" && x.kind === "user")) {
      const rules = c.rules.filter((r) => r.scope !== "user");
      const decision = run({
        tool: c.tool,
        options: { mode: "ask-all" },
        rules,
        settings: c.settings,
      });
      expect(decision.effect, c.tool.name).not.toBe("allow");
    }
  });

  it("in auto and scheduled runs, non-read tools run only when allow-listed", () => {
    for (const c of combos.filter((x) => x.mode === "auto" || x.kind === "schedule")) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: c.rules,
        settings: c.settings,
      });
      if (decision.effect === "allow" && c.tool.risk !== "read") {
        expect(["user_allow_rule", "team_allow_rule"], c.tool.name).toContain(
          decision.reasons[0]?.code,
        );
      }
    }
  });

  it("is deterministic: the same call decides the same way", () => {
    for (const c of combos.slice(0, 200)) {
      const args = {
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: c.rules,
        settings: c.settings,
      };
      expect(run(args)).toEqual(run(args));
    }
  });

  it("decides fast: 1,000 rules × 1,000 calls", () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      rule(i % 2 === 0 ? "team" : "user", i % 2 === 0 ? "deny" : "allow", `mcp__svc${i}__x`, {
        arg_pattern: { "/a/b": `*${i}*` },
      }),
    );
    const rules = ruleSet(many);
    // Five batches of 200 calls (1,000 in all); judge the fastest batch. A load spike (parallel
    // verify on an 8 GB VM) slows some batches, but cannot slow all of them, so the minimum
    // measures the evaluator and not the machine (KOBE-655).
    const batchMs: number[] = [];
    for (let batch = 0; batch < 5; batch += 1) {
      const start = performance.now();
      for (let i = 0; i < 200; i += 1) {
        evaluatePolicy({
          input: policyInput(jiraCreate, { a: { b: `value-${batch * 200 + i}` } }),
          tool: jiraCreate,
          rules,
          connector: ENABLED_ALL,
          settings: DEFAULT_POLICY_SETTINGS,
          now: NOW,
        });
      }
      batchMs.push((performance.now() - start) / 200);
    }
    // Generous for shared CI runners; locally this is well under 1 ms.
    expect(Math.min(...batchMs)).toBeLessThan(10);
    // The budget above allows up to 10 s; vitest's default 5 s timeout would cut it short.
  }, 30_000);
});
