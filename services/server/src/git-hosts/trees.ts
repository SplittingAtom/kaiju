import { GitHostError } from "./adapter.js";

/**
 * One level of a git tree as GitHub, Gitea and Forgejo answer `git/trees/{sha}` (KOBE-767:
 * committing to a Repo writes a new commit on top of the host's tree, so the server reads the
 * folders a commit changes, never the whole repository). The three hosts answer in the same JSON
 * shape (`sha`, `tree[]` of `path`, `mode`, `type`, `sha`, plus `truncated`; Gitea and Forgejo
 * page it). Anything without its fields is `unexpected`; names that git or Kobe would misread
 * are refused rather than handed on.
 */
export type GitTreeEntryType = "blob" | "tree" | "commit";

export interface GitTreeEntry {
  /** One path segment. */
  readonly name: string;
  /** `100644`, `100755`, `120000` (link), `40000` (folder) or `160000` (submodule). */
  readonly mode: string;
  readonly type: GitTreeEntryType;
  readonly sha: string;
}

export interface GitTree {
  readonly sha: string;
  readonly entries: readonly GitTreeEntry[];
}

/** Most entries of one folder Kobe reads (a larger folder is refused, not cut). */
export const GIT_TREE_MAX_ENTRIES = 10_000;
/** Page size asked of Gitea and Forgejo (their default maximum for trees). */
export const GIT_TREE_PAGE_SIZE = 1000;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODES = new Set(["100644", "100755", "120000", "40000", "040000", "160000"]);
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[/\u0000]/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

function unexpected(): GitHostError {
  return new GitHostError("unexpected", "The git host gave an unexpected answer.");
}

/** A tree id Kobe asks for: a full commit or tree SHA. */
export function assertTreeSha(sha: string): string {
  if (!SHA.test(sha)) throw new GitHostError("invalid_request", "That is not a commit id.");
  return sha;
}

/** One page of a `git/trees/{sha}` answer. */
export function treePage(json: unknown): {
  readonly sha: string;
  readonly entries: GitTreeEntry[];
  readonly truncated: boolean;
  readonly total: number | null;
} {
  const body = obj(json);
  const sha = body.sha;
  const tree = body.tree;
  if (typeof sha !== "string" || !SHA.test(sha) || !Array.isArray(tree)) throw unexpected();
  const entries = tree.map((raw): GitTreeEntry => {
    const e = obj(raw);
    const { path, mode, type } = e;
    const entrySha = e.sha;
    if (
      typeof path !== "string" ||
      path === "" ||
      path === "." ||
      path === ".." ||
      path.length > 255 ||
      BAD_NAME.test(path) ||
      typeof mode !== "string" ||
      !MODES.has(mode) ||
      (type !== "blob" && type !== "tree" && type !== "commit") ||
      typeof entrySha !== "string" ||
      !SHA.test(entrySha)
    ) {
      throw unexpected();
    }
    return { name: path, mode: mode === "040000" ? "40000" : mode, type, sha: entrySha };
  });
  const total = typeof body.total_count === "number" ? body.total_count : null;
  return { sha, entries, truncated: body.truncated === true, total };
}

/** Refuses a folder larger than Kobe reads. */
export function assertTreeSize(count: number): void {
  if (count > GIT_TREE_MAX_ENTRIES) {
    throw new GitHostError("invalid_request", "A folder in the repository has too many entries.", {
      reason: "tree_too_large",
    });
  }
}
