import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  type PolicyDecision,
  type PolicyInput,
  type ToolDescriptor,
} from "@kaiju/protocol";
import { KAIJU_BUILTIN_CONNECTOR_ID } from "@kaiju/db";
import { batchable } from "../approvals/approve-all.js";
import {
  guardKaijuAdmin,
  isKaijuAdminAsk,
  isKaijuAdminTool,
  isKaijuTool,
  kaijuToolName,
  type KaijuAdminGuard,
} from "./kaiju-admin-guard.js";

/** KOBE-619 (spec kobe-admin-mcp §6, KA2): Kaiju admin writes ask in every mode. */
const NOW = new Date("2026-11-11T10:00:00.000Z");
const kaiju = (risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name: "mcp__kobe__team_members_set_role",
  source: "mcp",
  connector_id: KAIJU_BUILTIN_CONNECTOR_ID,
  risk,
  open_world: false,
  scope: "external",
});
const other: ToolDescriptor = {
  ...kaiju("write"),
  connector_id: "00000000-0000-4000-8000-000000000009",
};

const allow = (code: string, stage = "approval_mode"): PolicyDecision =>
  ({
    effect: "allow",
    risk: "write",
    reasons: [{ code, stage, message: code }],
  }) as PolicyDecision;
const DENY: PolicyDecision = {
  effect: "deny",
  risk: "write",
  reasons: [{ code: "agent_tool_deny", stage: "team_deny", message: "denied" }],
};

function input(mode: PolicyInput["run"]["approval_mode"], kind: "user" | "schedule" = "user") {
  return {
    actor: { user_id: "u", kind },
    run: { run_id: "r", thread_id: "t", approval_mode: mode },
  } as unknown as PolicyInput;
}

const g = (over: Partial<KaijuAdminGuard> = {}): KaijuAdminGuard => ({
  tool: kaiju("write"),
  input: input("ask-on-write"),
  evalRun: false,
  now: NOW,
  ...over,
});

describe("guardKaijuAdmin", () => {
  it.each([
    ["Dangerous mode", allow("dangerous_mode")],
    ["a remembered approval", allow("user_allow_rule", "user_allow")],
    ["a team allow rule", allow("team_allow_rule", "user_allow")],
    ["a plain allow", allow("risk_read", "risk_class")],
  ])("asks for a write whatever allowed it (%s), dropping the allow reasons", (_, decision) => {
    const out = guardKaijuAdmin(decision, g());
    expect(out.effect).toBe("require_approval");
    expect(out.reasons.map((r) => r.code)).not.toContain("dangerous_mode");
    expect(out.reasons.map((r) => r.code)).not.toContain("user_allow_rule");
    expect(out.reasons[0]?.code).toBe("kobe_admin_write");
    expect(isKaijuAdminAsk(out.reasons)).toBe(true);
    if (out.effect === "require_approval") {
      expect(Date.parse(out.expires_at)).toBe(NOW.getTime() + APPROVAL_TTL_MS);
    }
  });

  it.each(["ask-on-write", "ask-all"] as const)("asks in %s", (mode) => {
    expect(guardKaijuAdmin(allow("dangerous_mode"), g({ input: input(mode) })).effect).toBe(
      "require_approval",
    );
  });

  it("denies a write where nobody can be asked: auto, scheduled, skill eval", () => {
    expect(guardKaijuAdmin(allow("team_allow_rule"), g({ input: input("auto") }))).toMatchObject({
      effect: "deny",
      reasons: [{ code: "kobe_admin_write" }],
    });
    for (const over of [{ input: input("auto", "schedule") }, { evalRun: true }]) {
      expect(guardKaijuAdmin(allow("team_allow_rule"), g(over))).toMatchObject({
        effect: "deny",
        reasons: [{ code: "kobe_admin_not_allowed" }],
      });
    }
  });

  it("denies even a read in scheduled runs and evals; lets reads follow the policy otherwise", () => {
    const read = g({ tool: kaiju("read") });
    const allowed = allow("risk_read", "risk_class");
    expect(guardKaijuAdmin(allowed, read)).toBe(allowed);
    expect(guardKaijuAdmin(allowed, { ...read, input: input("auto") })).toBe(allowed);
    expect(guardKaijuAdmin(allowed, { ...read, evalRun: true }).effect).toBe("deny");
    expect(guardKaijuAdmin(allowed, { ...read, input: input("auto", "schedule") }).effect).toBe(
      "deny",
    );
  });

  it("leaves a deny, and every other tool, as they are", () => {
    expect(guardKaijuAdmin(DENY, g())).toBe(DENY);
    const allowed = allow("dangerous_mode");
    expect(guardKaijuAdmin(allowed, g({ tool: other }))).toBe(allowed);
    expect(isKaijuTool(other)).toBe(false);
    expect(kaijuToolName("mcp__kaiju_builtin__team_members_list")).toBe("team_members_list");
  });

  it("leaves the docs tools to the ordinary policy: scheduled runs, evals and auto too (KOBE-620)", () => {
    const docs: ToolDescriptor = { ...kaiju("read"), name: "mcp__kobe__docs_index" };
    expect(isKaijuTool(docs)).toBe(true);
    expect(isKaijuAdminTool(docs)).toBe(false);
    expect(isKaijuAdminTool(kaiju("read"))).toBe(true);
    const allowed = allow("risk_read", "risk_class");
    const read = g({ tool: docs });
    expect(guardKaijuAdmin(allowed, read)).toBe(allowed);
    expect(guardKaijuAdmin(allowed, { ...read, evalRun: true })).toBe(allowed);
    expect(guardKaijuAdmin(allowed, { ...read, input: input("auto", "schedule") })).toBe(allowed);
    expect(guardKaijuAdmin(allowed, { ...read, input: input("auto") })).toBe(allowed);
  });

  it("is never approved in bulk", () => {
    const row = {
      risk: "write" as const,
      tool: kaiju("write").name,
      inputCanonical: "{}",
      reasons: [{ code: "kobe_admin_write", stage: "ask_rule", message: "m" }],
    };
    expect(batchable(row as never, kaiju("write"))).toBe(false);
    expect(batchable({ ...row, reasons: [] } as never, kaiju("write"))).toBe(true);
  });
});
