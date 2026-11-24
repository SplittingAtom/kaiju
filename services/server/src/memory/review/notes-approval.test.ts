import { describe, expect, it } from "vitest";
import { verifyApproval } from "@kaiju/protocol/node";
import { approvalKeyring } from "../../approvals/keys.js";
import {
  SUGGESTION_TOOL,
  notesKeyring,
  signNotesApproval,
  verifyNotesApproval,
  type NotesChange,
} from "./notes-approval.js";

const keys = approvalKeyring("n".repeat(48));
const change: NotesChange = {
  teamId: "11111111-1111-4111-8111-111111111111",
  passId: "22222222-2222-4222-8222-222222222222",
  candidateId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
  projectId: "55555555-5555-4555-8555-555555555555",
  baseVersion: 3,
  line: "- We ship on Tuesdays.",
};
const now = new Date("2026-11-15T10:00:00.000Z");

describe("the signed approval of a Notes change (KOBE-398)", () => {
  it("verifies exactly the change it was signed over", () => {
    const token = signNotesApproval(keys, change, now);
    expect(verifyNotesApproval(keys, token, change, now)).toBe("ok");
    for (const over of [
      { line: "- We ship on Mondays." },
      { baseVersion: 4 },
      { projectId: "66666666-6666-4666-8666-666666666666" },
      { userId: "66666666-6666-4666-8666-666666666666" },
      { candidateId: "66666666-6666-4666-8666-666666666666" },
    ])
      expect(verifyNotesApproval(keys, token, { ...change, ...over }, now)).toBe("mismatch");
  });

  it("expires with the approval token lifetime and refuses junk", () => {
    const token = signNotesApproval(keys, change, now);
    expect(verifyNotesApproval(keys, token, change, new Date(now.getTime() + 11 * 60_000))).toBe(
      "expired",
    );
    expect(verifyNotesApproval(keys, { nope: true }, change, now)).toBe("mismatch");
  });

  it("is signed with a key derived for Notes, so it never passes as a tool approval", () => {
    const token = signNotesApproval(keys, change, now);
    expect(token.kid).toBe(notesKeyring(keys).current.kid);
    expect(token.kid).not.toBe(keys.current.kid);
    const asTool = verifyApproval({
      token,
      expected: {
        team_id: token.team_id,
        run_id: token.run_id,
        tool_call_id: token.tool_call_id,
        tool: token.tool,
      },
      input: { anything: true },
      now,
      keyFor: keys.keyFor,
    });
    expect(asTool).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("keeps a suggestion's approval apart from a candidate's (KOBE-652)", () => {
    const candidateToken = signNotesApproval(keys, change, now);
    const suggestion = { ...change, tool: SUGGESTION_TOOL } as const;
    expect(verifyNotesApproval(keys, candidateToken, suggestion, now)).toBe("mismatch");
    const token = signNotesApproval(keys, suggestion, now);
    expect(token.tool).toBe(SUGGESTION_TOOL);
    expect(verifyNotesApproval(keys, token, suggestion, now)).toBe("ok");
    expect(verifyNotesApproval(keys, token, change, now)).toBe("mismatch");
  });
});
