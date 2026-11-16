import { createHmac } from "node:crypto";
import type { ApprovalToken } from "@kobe/protocol";
import { signApproval, verifyApproval, type ApprovalKey } from "@kobe/protocol/node";
import type { ApprovalKeyring } from "../../approvals/keys.js";
import { MEMORY_INDEX_FILE } from "@kobe/protocol";

/**
 * The signed approval of a project Notes change from To review (KOBE-398; D24: a project memory
 * write needs a signed approval). The person asks to add a candidate; the server computes the
 * exact change (the line under `## Learned` and the `MEMORY.md` version it applies to) and signs
 * it with the site's approval key in the approval token format (`@kobe/protocol` approval.ts);
 * the person approves that change and the write verifies the token against the change it is
 * about to make, recomputed from the database. Any difference (the line, the base version, the
 * project, the person, the candidate) refuses the write.
 *
 * - **Domain separated:** signed with a key derived from the approval key for Notes alone (own
 *   kid), so a Notes token never verifies as a tool approval and a tool approval never verifies
 *   here.
 * - **Binding:** `run_id` = the learning pass, `tool_call_id` = the candidate, `tool` =
 *   {@link NOTES_TOOL}; the signed input names the person, project, file, base version and line.
 * - **Single use:** the candidate row (locked, `open`) is the record: a decided candidate refuses
 *   a second write, so no approvals row is needed.
 * - Lives 10 minutes (`APPROVAL_TOKEN_TTL_MS`). The panel holds it as an opaque string
 *   ({@link encodeNotesApproval}) and sends it back unchanged.
 */

export const NOTES_TOOL = "kobe.project_notes.add";
const NOTES_KEY_LABEL = "kobe.project_notes.v1";

export interface NotesChange {
  readonly teamId: string;
  readonly passId: string;
  readonly candidateId: string;
  readonly userId: string;
  readonly projectId: string;
  /** `MEMORY.md`'s version the line is added to (0: no file yet). */
  readonly baseVersion: number;
  readonly line: string;
}

/** The Notes key: HMAC(approval key, label), with its own kid. */
export function notesKeyring(keys: ApprovalKeyring): {
  current: ApprovalKey;
  keyFor(kid: string): ApprovalKey | undefined;
} {
  const secret = createHmac("sha256", keys.current.secret).update(NOTES_KEY_LABEL).digest();
  const current: ApprovalKey = { kid: `${keys.current.kid}-pn`, secret: new Uint8Array(secret) };
  return { current, keyFor: (kid) => (kid === current.kid ? current : undefined) };
}

const inputOf = (c: NotesChange) => ({
  user_id: c.userId,
  project_id: c.projectId,
  path: MEMORY_INDEX_FILE,
  base_version: c.baseVersion,
  line: c.line,
});

export function signNotesApproval(
  keys: ApprovalKeyring,
  change: NotesChange,
  now: Date,
): ApprovalToken {
  return signApproval({
    key: notesKeyring(keys).current,
    approval_id: change.candidateId,
    team_id: change.teamId,
    run_id: change.passId,
    tool_call_id: change.candidateId,
    tool: NOTES_TOOL,
    input: inputOf(change),
    now,
  });
}

export function verifyNotesApproval(
  keys: ApprovalKeyring,
  token: unknown,
  change: NotesChange,
  now: Date,
): "ok" | "expired" | "mismatch" {
  const res = verifyApproval({
    token,
    expected: {
      team_id: change.teamId,
      run_id: change.passId,
      tool_call_id: change.candidateId,
      tool: NOTES_TOOL,
    },
    input: inputOf(change),
    now,
    keyFor: notesKeyring(keys).keyFor,
  });
  if (res.ok) return "ok";
  return res.reason === "expired" ? "expired" : "mismatch";
}

/** The token as the panel carries it: base64url of its JSON (opaque to the web client). */
export function encodeNotesApproval(token: ApprovalToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/** The token from the panel's string; anything unreadable is `undefined` (a mismatch). */
export function decodeNotesApproval(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
