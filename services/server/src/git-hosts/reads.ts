import {
  GitHostError,
  safeWebUrl,
  type GitBranch,
  type GitFileContent,
  type GitFileEntry,
  type GitIssue,
  type GitListState,
  type GitPullRequest,
} from "./adapter.js";

/**
 * The read side of the git host tools (spec workspace-git G9; KOBE-762) mapped once for every
 * provider: GitHub, Gitea and Forgejo answer branches, contents, pull requests and issues in the
 * same JSON shapes (Gitea modelled its API on GitHub's), so each adapter only builds the request
 * and hands the answer here. Everything is bounded: bodies and file text are cut to fixed caps,
 * web links pass {@link safeWebUrl}, and anything without its fields is `unexpected`.
 */

/** Longest pull request or issue body handed on (characters). */
export const GIT_READ_BODY_MAX = 16_000;
/** Longest file text handed on (bytes of UTF-8). */
export const GIT_READ_FILE_MAX_BYTES = 48 * 1024;
/** Entries of a directory listing handed on. */
export const GIT_READ_DIR_MAX = 200;
/** Page size of the list reads (both hosts cap pages lower or equal). */
export const GIT_READ_PAGE_DEFAULT = 30;
export const GIT_READ_PAGE_MAX = 50;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const time = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && s.length <= 40 && !Number.isNaN(Date.parse(s)) ? s : null;
};

function unexpected(): GitHostError {
  return new GitHostError("unexpected", "The git host gave an unexpected answer.");
}

/** A page size within the read limits. */
export function readPageSize(perPage: number | undefined): number {
  const n = Math.floor(perPage ?? GIT_READ_PAGE_DEFAULT);
  return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), GIT_READ_PAGE_MAX);
}

export function listState(state: GitListState | undefined): GitListState {
  return state === "closed" || state === "all" ? state : "open";
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A repository file path Kaiju sends: relative, `/`-separated, no empty, `.` or `..` segment, no
 * control character, at most 1000 characters. Returned percent-encoded per segment for the URL.
 */
export function encodeFilePath(path: string): string {
  if (path.length > 1000 || CONTROL.test(path)) {
    throw new GitHostError("invalid_request", "That is not a valid file path.");
  }
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  // The repository's root directory.
  if (trimmed === "") return "";
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new GitHostError("invalid_request", "That is not a valid file path.");
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** A cut to `max` characters, with whether anything was cut. */
function bounded(text: string | null, max: number): { text: string; cut: boolean } {
  const t = text ?? "";
  return t.length > max ? { text: t.slice(0, max), cut: true } : { text: t, cut: false };
}

export function toBranch(json: unknown): GitBranch {
  const b = obj(json);
  const commit = obj(b.commit);
  const name = str(b.name);
  const sha = str(commit.sha) ?? str(commit.id);
  if (name === null || sha === null || name.length > 255 || !/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw unexpected();
  }
  return {
    name,
    commitSha: sha,
    protected: typeof b.protected === "boolean" ? b.protected : null,
  };
}

/** Pull request `head`: the branch, prefixed with its owner when in another repository. */
function headOf(pr: Json, organization: string): string {
  const head = obj(pr.head);
  const ref = str(head.ref) ?? "";
  const owner = str(obj(obj(head.repo).owner).login);
  return owner !== null && owner.toLowerCase() !== organization.toLowerCase()
    ? `${owner}:${ref}`
    : ref;
}

export function toPullRequest(
  json: unknown,
  webBase: string,
  organization: string,
  withBody: boolean,
): GitPullRequest {
  const pr = obj(json);
  const number = int(pr.number);
  const title = str(pr.title);
  const rawState = str(pr.state);
  if (number === null || number === 0 || title === null || rawState === null) throw unexpected();
  const merged = pr.merged === true || str(pr.merged_at) !== null;
  const state = merged ? "merged" : rawState === "closed" ? "closed" : "open";
  const body = bounded(str(pr.body), GIT_READ_BODY_MAX);
  return {
    number,
    title: title.slice(0, 1000),
    state,
    draft: pr.draft === true,
    head: headOf(pr, organization).slice(0, 300),
    base: (str(obj(pr.base).ref) ?? "").slice(0, 255),
    author: str(obj(pr.user).login),
    webUrl: safeWebUrl(pr.html_url, webBase),
    createdAt: time(pr.created_at),
    updatedAt: time(pr.updated_at),
    ...(withBody ? { body: body.text, bodyTruncated: body.cut } : {}),
  };
}

/** Whether an issue answer is really a pull request (both hosts mark it). */
export function isPullRequestIssue(json: unknown): boolean {
  const pr = obj(json).pull_request;
  return pr !== undefined && pr !== null;
}

export function toIssue(json: unknown, webBase: string, withBody: boolean): GitIssue {
  const i = obj(json);
  const number = int(i.number);
  const title = str(i.title);
  if (number === null || number === 0 || title === null) throw unexpected();
  const body = bounded(str(i.body), GIT_READ_BODY_MAX);
  return {
    number,
    title: title.slice(0, 1000),
    state: str(i.state) === "closed" ? "closed" : "open",
    author: str(obj(i.user).login),
    webUrl: safeWebUrl(i.html_url, webBase),
    comments: int(i.comments),
    createdAt: time(i.created_at),
    updatedAt: time(i.updated_at),
    ...(withBody ? { body: body.text, bodyTruncated: body.cut } : {}),
  };
}

const ENTRY_TYPES: Readonly<Record<string, GitFileEntry["type"]>> = {
  file: "file",
  dir: "dir",
  symlink: "symlink",
  submodule: "submodule",
};

function toEntry(json: unknown): GitFileEntry | undefined {
  const e = obj(json);
  const name = str(e.name);
  const path = str(e.path);
  const type = ENTRY_TYPES[str(e.type) ?? ""];
  if (name === null || path === null || type === undefined) return undefined;
  return { name: name.slice(0, 255), path: path.slice(0, 1000), type, size: int(e.size) };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Cuts UTF-8 text to `max` bytes without splitting a character. */
function cutUtf8(text: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

/** A `contents` answer: a directory (an array) or one file with base64 content. */
export function toFileContent(json: unknown, path: string): GitFileContent {
  if (Array.isArray(json)) {
    const entries = json
      .map(toEntry)
      .filter((e): e is GitFileEntry => e !== undefined)
      .slice(0, GIT_READ_DIR_MAX);
    return { kind: "directory", path, entries };
  }
  const f = obj(json);
  if (str(f.type) !== "file") {
    // A symlink or submodule read directly: no text to give.
    if (str(f.type) === "symlink" || str(f.type) === "submodule") {
      return {
        kind: "file",
        path,
        size: int(f.size) ?? 0,
        sha: str(f.sha) ?? "",
        binary: true,
        truncated: false,
        content: "",
      };
    }
    throw unexpected();
  }
  const size = int(f.size) ?? 0;
  const sha = str(f.sha) ?? "";
  const encoded = str(f.content);
  // GitHub sends no content for files over 1 MB (`encoding: "none"`).
  if (encoded === null || str(f.encoding) !== "base64") {
    return { kind: "file", path, size, sha, binary: false, truncated: size > 0, content: "" };
  }
  const raw = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    return { kind: "file", path, size, sha, binary: true, truncated: false, content: "" };
  }
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(text)) {
    return { kind: "file", path, size, sha, binary: true, truncated: false, content: "" };
  }
  const cut = cutUtf8(text, GIT_READ_FILE_MAX_BYTES);
  return { kind: "file", path, size, sha, binary: false, truncated: cut.cut, content: cut.text };
}

/** A full commit SHA (40 hex for SHA-1, 64 for SHA-256 repositories). */
export const isCommitSha = (value: string): boolean =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
