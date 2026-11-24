import { describe, expect, it } from "vitest";
import type { PolicyDecision, ToolDescriptor } from "@kaiju/protocol";
import { KAIJU_BUILTIN_CONNECTOR_ID, type KaijuDb } from "@kaiju/db";
import { guardKaijuAdminCall } from "./person-guard.js";

/** Review L4: a malformed admin write is refused at policy.check, before any approval card. */
const tool: ToolDescriptor = {
  name: "mcp__kobe__team_members_set_role",
  source: "mcp",
  connector_id: KAIJU_BUILTIN_CONNECTOR_ID,
  risk: "write",
  open_world: false,
  scope: "external",
};
const ASK: PolicyDecision = {
  effect: "require_approval",
  risk: "write",
  reasons: [{ code: "kobe_admin_write", stage: "ask_rule", message: "m" }],
  expires_at: new Date().toISOString(),
};
const noDb = {} as KaijuDb;

describe("guardKaijuAdminCall input check", () => {
  it.each([
    [{}],
    [{ user_id: "x", from_role: "member", to_role: "team_admin" }],
    [{ user_id: "00000000-0000-4000-8000-000000000001", from_role: "member", to_role: "boss" }],
    [
      {
        user_id: "00000000-0000-4000-8000-000000000001",
        from_role: "member",
        to_role: "team_admin",
        extra: 1,
      },
    ],
  ])("denies %j as invalid_input without asking", async (input) => {
    const out = await guardKaijuAdminCall(noDb, { teamId: "t", userId: "u" }, ASK, tool, input);
    expect(out).toMatchObject({ effect: "deny", reasons: [{ code: "invalid_input" }] });
  });
});
