import { GitHostError } from "../git-hosts/adapter.js";

/**
 * What the agent is told when the host refuses or fails (KOBE-762, §9): a fixed code and a fixed
 * sentence per adapter error, never the host's own text (the adapters already keep host prose out
 * of their errors). A rate limit carries the time to retry, as a typed `retry_at`.
 */
export interface GitToolError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** ISO time after which a retry may succeed (host rate limits, Kaiju's own limits). */
  readonly retryAt?: string;
}

export const toolError = (code: string, message: string, retryAt?: Date): GitToolError => ({
  ok: false,
  code,
  message: retryAt === undefined ? message : `${message} Try again after ${retryAt.toISOString()}.`,
  ...(retryAt === undefined ? {} : { retryAt: retryAt.toISOString() }),
});

export function hostError(err: unknown): GitToolError {
  if (!(err instanceof GitHostError)) {
    return toolError("host_unavailable", "The git host could not be reached; try again shortly.");
  }
  switch (err.code) {
    case "not_found":
      return toolError(
        "not_found",
        "Not found in the connected organization, or the Workspace's credential cannot see it.",
      );
    case "invalid_request":
      return toolError(
        "invalid_request",
        "The git host (or Kaiju) refused that input as not valid.",
      );
    case "conflict":
      return toolError("already_exists", "That already exists on the git host.");
    case "forbidden":
      return toolError(
        "credential_forbidden",
        err.missingPermission === undefined
          ? "The Workspace's git credential is not allowed to do that; a Workspace admin should check its permissions."
          : `The Workspace's git credential lacks the permission ${err.missingPermission}; a Workspace admin should add it.`,
      );
    case "auth_failed":
      return toolError(
        "credential_rejected",
        "The git host refused the Workspace's credential; a Workspace admin should check the connection.",
      );
    case "rate_limited":
      return toolError(
        "host_rate_limited",
        "The git host is rate limiting Kaiju.",
        err.resetAt ?? new Date(Date.now() + 60_000),
      );
    case "host_refused":
      return toolError("site_refused", "This Site does not allow that git host now.");
    case "unsupported_host":
      return toolError(
        "unsupported_host",
        "The git host runs a version Kaiju does not support; a Workspace admin should check the connection.",
      );
    default:
      return toolError("host_unavailable", "The git host could not be reached; try again shortly.");
  }
}
