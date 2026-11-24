import { describe, expect, it } from "vitest";
import { rule } from "../testing/policy-fixtures.js";
import { EARLY_CASES } from "./evaluate.cases-early.test-helpers.js";
import { LATE_CASES } from "./evaluate.cases-late.test-helpers.js";
import { run, bash, kaijuWrite, type Case } from "./evaluate.test-helpers.js";

// Each row isolates one layer of the D29 order winning or losing against the layers after it.
// Inputs default to a valid sample for the tool (SAMPLE_INPUTS).
const CASES: readonly Case[] = [...EARLY_CASES, ...LATE_CASES];

describe("evaluatePolicy: D29 order, table-driven", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const decision = run(c);
    expect(decision.effect).toBe(c.effect);
    expect(decision.reasons.map((r) => r.code)).toEqual(c.codes);
    expect(decision.risk).toBe(c.tool.risk);
  });

  it("reports the matching rule id, deterministically the lowest id", () => {
    const a = rule("team", "deny", "bash", { id: "00000000-0000-4000-8000-00000000000b" });
    const b = rule("team", "deny", "b*", { id: "00000000-0000-4000-8000-00000000000a" });
    const first = run({ tool: bash, rules: [a, b] });
    const second = run({ tool: bash, rules: [b, a] });
    expect(first).toEqual(second);
    expect(first.reasons.map((r) => r.rule_id)).toEqual([b.id, a.id]);
  });

  it("names the user rule that removed a prompt", () => {
    const allow = rule("user", "allow", "share_file");
    expect(run({ tool: kaijuWrite, rules: [allow] }).reasons[0]).toMatchObject({
      code: "user_allow_rule",
      stage: "user_allow",
      rule_id: allow.id,
    });
  });

  it("in auto mode only the team's allow rule allow-lists, never the member's own (KOBE-289)", () => {
    const team = rule("team", "allow", "share_file");
    const user = rule("user", "allow", "share_file");
    const decision = run({ tool: kaijuWrite, rules: [team, user], options: { mode: "auto" } });
    expect(decision.reasons[0]).toMatchObject({ code: "team_allow_rule", rule_id: team.id });
  });

  it("sets a 1 h approval expiry on prompts", () => {
    const decision = run({ tool: kaijuWrite });
    expect(decision).toMatchObject({
      effect: "require_approval",
      expires_at: "2026-10-02T13:00:00.000Z",
    });
  });

  it("keeps the protocol's evaluation-order stages on every reason", () => {
    const decision = run({ tool: bash, rules: [rule("site", "deny", "bash")] });
    expect(decision.reasons[0]?.stage).toBe("site_deny");
  });
});
