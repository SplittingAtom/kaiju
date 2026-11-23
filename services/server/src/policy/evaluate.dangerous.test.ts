import { describe, expect, it } from "vitest";
import { builtin, ENABLED_ALL, rule } from "../testing/policy-fixtures.js";
import { type Case, run, kobeWrite, jiraCreate, jiraSearch } from "./evaluate.test-helpers.js";

describe("evaluatePolicy: Dangerous mode (AC1, KOBE-476)", () => {
  /** A Dangerous agent that picked only a connector: its tools are named one by one. */
  const dangerous = ["mcp__jira__create_issue", "mcp__jira__search"];
  const interactive = ["ask-on-write", "ask-all"] as const;

  it("allows only a tool the agent names explicitly, where the call would ask", () => {
    for (const mode of interactive) {
      const decision = run({ tool: jiraCreate, options: { dangerous, mode } });
      expect(decision.effect, mode).toBe("allow");
      expect(decision.reasons[0]).toMatchObject({ code: "dangerous_mode", stage: "approval_mode" });
    }
  });

  it("leaves every tool it doesn't name as it was: built-ins still ask", () => {
    for (const name of ["bash", "write", "edit", "propose_file_edit"]) {
      const tool = builtin(name);
      const decision = run({ tool, options: { dangerous, mode: "ask-all" } });
      expect(decision.effect, name).toBe("require_approval");
      expect(decision.reasons.map((r) => r.code)).not.toContain("dangerous_mode");
    }
  });

  it("never lifts a Kobe-scoped write's prompt, even when named (U10, D23, D24)", () => {
    for (const mode of interactive) {
      const decision = run({
        tool: kobeWrite,
        options: { dangerous: [...dangerous, kobeWrite.name], mode },
      });
      expect(decision.effect, mode).toBe("require_approval");
    }
  });

  it("never turns an auto-mode or scheduled refusal into allow (D29, D32)", () => {
    const auto = run({ tool: jiraCreate, options: { dangerous, mode: "auto" } });
    expect(auto.effect).toBe("deny");
    expect(auto.reasons[0]?.code).toBe("mode_auto_not_allowlisted");
    const scheduled = run({ tool: jiraCreate, options: { dangerous, kind: "schedule" } });
    expect(scheduled.effect).toBe("deny");
    expect(scheduled.reasons[0]?.code).toBe("scheduled_run_no_prompt");
  });

  it("never lifts a deny: site and team deny rules, the agent's tool lists, connector gates", () => {
    const cases: Omit<Case, "name" | "effect" | "codes">[] = [
      { tool: jiraCreate, rules: [rule("site", "deny", "mcp__jira__*")] },
      { tool: jiraCreate, rules: [rule("team", "deny", "mcp__jira__create_issue")] },
      { tool: jiraCreate, options: { toolsDeny: ["mcp__jira__create_issue"] } },
      { tool: jiraCreate, connector: { ...ENABLED_ALL, exposure: "read_only" } },
      { tool: jiraCreate, connector: { ...ENABLED_ALL, enabled: false } },
      { tool: jiraCreate, connector: { ...ENABLED_ALL, drifted_tools: [jiraCreate.name] } },
    ];
    for (const c of cases) {
      const decision = run({ ...c, options: { ...c.options, dangerous } });
      expect(decision.effect, JSON.stringify(c)).toBe("deny");
      expect(decision.reasons.map((r) => r.code)).not.toContain("dangerous_mode");
    }
  });

  it("never lifts a site or team ask rule", () => {
    for (const scope of ["site", "team"] as const) {
      const decision = run({
        tool: jiraCreate,
        rules: [rule(scope, "ask", "mcp__jira__*")],
        options: { dangerous },
      });
      expect(decision.effect).toBe("require_approval");
    }
  });

  it("leaves calls that run anyway with their own reason (no Dangerous audit row for them)", () => {
    const decision = run({ tool: jiraSearch, options: { dangerous } });
    expect(decision.effect).toBe("allow");
    expect(decision.reasons[0]?.code).toBe("risk_read");
  });

  it("changes nothing when the server set no tools", () => {
    expect(run({ tool: jiraCreate }).effect).toBe("require_approval");
  });
});
