import { describe, expect, it } from "vitest";
import { APPROVAL_MODES } from "@kobe/protocol";
import { run, read, jiraSearch } from "./evaluate.test-helpers.js";

describe("evaluatePolicy: the agent's tools.deny in every mode (KOBE-481)", () => {
  it("refuses a denied built-in and a denied MCP tool whatever the mode or trigger", () => {
    for (const mode of APPROVAL_MODES) {
      for (const kind of ["user", "schedule"] as const) {
        for (const [tool, deny] of [
          [read, "read"],
          [jiraSearch, "mcp__jira__*"],
        ] as const) {
          const decision = run({ tool, options: { mode, kind, toolsDeny: [deny] } });
          expect(decision.effect, `${mode}/${kind}/${tool.name}`).toBe("deny");
          expect(decision.reasons[0]?.code).toBe("agent_tool_deny");
        }
      }
    }
  });
});
