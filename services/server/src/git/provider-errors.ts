/**
 * The typed failures every git host adapter throws (KOBE-758/759). Messages are fixed, written for
 * an admin or an agent, and never carry a URL, a header, a token or a response body; the host's
 * own message is never copied in (only a scope name parsed out of it).
 */

export type GitHostErrorCode =
  /** The credential was refused (wrong, revoked or expired). */
  | "auth_failed"
  /** The credential is valid but may not do this; `missingScope` when the host names it. */
  | "forbidden"
  | "not_found"
  /** Already exists (repository name taken, pull request already open for the branch). */
  | "conflict"
  /** The host refused the input (validation). */
  | "invalid_request"
  /** The host throttled the credential; `retryAfterSeconds` when it says. */
  | "rate_limited"
  /** The base URL fails the address policy or the Site's host limit, or the host redirected. */
  | "host_not_allowed"
  | "host_unreachable"
  /** The host runs a version older than Kobe supports. */
  | "version_unsupported"
  | "unexpected";

const MESSAGES: Record<GitHostErrorCode, string> = {
  auth_failed: "The git host refused the credential. It may be wrong, revoked or expired.",
  forbidden: "The credential may not do this on the git host.",
  not_found:
    "The git host has no such organization or repository, or the credential cannot see it.",
  conflict: "That already exists on the git host.",
  invalid_request: "The git host refused the request as invalid.",
  rate_limited: "The git host is rate limiting this credential. Try again later.",
  host_not_allowed:
    "That git host is not allowed: its address is private or not permitted on this site, or it redirected elsewhere.",
  host_unreachable: "The git host could not be reached.",
  version_unsupported: "The git host runs a version Kobe does not support.",
  unexpected: "The git host gave an unexpected answer.",
};

export interface GitHostErrorDetails {
  /** HTTP status from the host, when there was one. */
  readonly status?: number;
  /** A token scope the host said is missing (e.g. `write:issue`). */
  readonly missingScope?: string;
  readonly retryAfterSeconds?: number;
  /** For `version_unsupported`: what the host runs and the minimum. */
  readonly version?: string;
  readonly minimumVersion?: string;
}

export class GitHostError extends Error {
  readonly code: GitHostErrorCode;
  readonly details: GitHostErrorDetails;
  constructor(code: GitHostErrorCode, details: GitHostErrorDetails = {}) {
    super(messageFor(code, details));
    this.name = "GitHostError";
    this.code = code;
    this.details = details;
  }
}

function messageFor(code: GitHostErrorCode, d: GitHostErrorDetails): string {
  if (code === "forbidden" && d.missingScope) {
    return `The credential lacks the token scope ${d.missingScope} for this on the git host.`;
  }
  if (code === "version_unsupported" && d.version && d.minimumVersion) {
    return `The git host runs version ${d.version}; Kobe supports ${d.minimumVersion} and later.`;
  }
  if (code === "rate_limited" && d.retryAfterSeconds !== undefined) {
    return `The git host is rate limiting this credential. Try again in ${d.retryAfterSeconds} s.`;
  }
  return MESSAGES[code];
}

export function isGitHostError(error: unknown): error is GitHostError {
  return error instanceof GitHostError;
}
