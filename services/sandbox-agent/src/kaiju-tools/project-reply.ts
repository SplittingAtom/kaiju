import type { ProjectCommitOutcome, ToolsResponse } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A branch name as the server sends it (KOBE-767): one line, no spaces, at most 255. */
const isBranch = (value: unknown): value is string =>
  typeof value === "string" && /^[^\s:~^?*[\\]{1,255}$/.test(value);

/** The host's link: "" or an http(s) URL of at most 2048 characters (KOBE-767). */
function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  if (value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The outcome of a `commit_project` answer (project-commits.ts), or undefined (fail closed). */
function parseCommitOutcome(value: unknown): ProjectCommitOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(",");
  switch (value.status) {
    case "committed":
      return keys === "seq,status" && isSeq(value.seq)
        ? { status: "committed", seq: value.seq }
        : undefined;
    case "commit_conflict":
      return keys === "head_seq,status" && isSeq(value.head_seq)
        ? { status: "commit_conflict", head_seq: value.head_seq }
        : undefined;
    case "nothing_to_commit":
    case "pending_approval":
      return keys === "status" ? { status: value.status } : undefined;
    case "pull_request":
      return keys === "branch,number,opened,status,url" &&
        isBranch(value.branch) &&
        isSeq(value.number) &&
        isWebUrl(value.url) &&
        typeof value.opened === "boolean"
        ? {
            status: "pull_request",
            branch: value.branch,
            number: value.number,
            url: value.url,
            opened: value.opened,
          }
        : undefined;
    case "pushed":
      return keys === "branch,seq,status" &&
        isBranch(value.branch) &&
        (value.seq === null || isSeq(value.seq))
        ? { status: "pushed", branch: value.branch, seq: value.seq }
        : undefined;
    default:
      return undefined;
  }
}

/** A `commit_project` answer (KOBE-580), or undefined when it is malformed (fail closed). */
export function parseProjectCommitReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const outcome = parseCommitOutcome(value.outcome);
  if (outcome === undefined) return undefined;
  return { id: value.id as string, ok: true, op: "project_commit", outcome };
}
