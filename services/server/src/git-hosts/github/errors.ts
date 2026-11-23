import { cappedResetAt, GitHostError } from "../adapter.js";
import { header, type HostResponse } from "../http.js";

/**
 * GitHub answers mapped to the adapter's typed errors (KOBE-758). Messages are fixed text; the
 * host's message is read only to tell cases apart, never copied into the error.
 */

/** Wait this long when GitHub signals a secondary rate limit without `retry-after`. */
const SECONDARY_DEFAULT_WAIT_S = 60;

function messageOf(res: HostResponse): string {
  const json = res.json as { message?: unknown; errors?: unknown } | undefined;
  const parts: string[] = [];
  if (typeof json?.message === "string") parts.push(json.message);
  if (Array.isArray(json?.errors)) {
    for (const e of json.errors as unknown[]) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof (e as { message?: unknown }).message === "string") {
        parts.push((e as { message: string }).message);
      } else if (e && typeof (e as { code?: unknown }).code === "string") {
        parts.push((e as { code: string }).code);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** The rate-limit error when the answer is one (primary or secondary), else undefined. */
function rateLimited(res: HostResponse, nowMs: number): GitHostError | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = seconds(header(res, "retry-after"));
  const message = messageOf(res);
  if (retryAfter !== undefined || message.includes("secondary rate limit")) {
    const wait = retryAfter ?? SECONDARY_DEFAULT_WAIT_S;
    return new GitHostError("rate_limited", "The git host's rate limit was reached.", {
      status: res.status,
      resetAt: cappedResetAt(nowMs + wait * 1000, nowMs),
      reason: "secondary",
    });
  }
  const remaining = header(res, "x-ratelimit-remaining");
  if (remaining === "0" || res.status === 429) {
    const reset = seconds(header(res, "x-ratelimit-reset"));
    return new GitHostError("rate_limited", "The git host's rate limit was reached.", {
      status: res.status,
      resetAt: cappedResetAt(
        reset !== undefined ? reset * 1000 : nowMs + SECONDARY_DEFAULT_WAIT_S * 1000,
        nowMs,
      ),
      reason: "primary",
    });
  }
  return undefined;
}

/** Maps a non-2xx GitHub answer to a {@link GitHostError}. */
export function githubError(res: HostResponse, nowMs: number): GitHostError {
  const status = res.status;
  const limited = rateLimited(res, nowMs);
  if (limited) return limited;
  const message = messageOf(res);
  if (status === 401) {
    return new GitHostError("auth_failed", "The git host rejected the credential.", {
      status,
      reason: "credential_rejected",
    });
  }
  if (status === 403) {
    if (message.includes("suspended")) {
      return new GitHostError("auth_failed", "The GitHub App installation is suspended.", {
        status,
        reason: "installation_suspended",
      });
    }
    const accepted = header(res, "x-accepted-github-permissions");
    return new GitHostError("forbidden", "The credential lacks a permission this needs.", {
      status,
      ...(accepted ? { missingPermission: accepted.trim() } : {}),
    });
  }
  if (status === 404 || status === 410) {
    return new GitHostError("not_found", "Not found in the connected organization.", { status });
  }
  if (status === 409) {
    return new GitHostError("conflict", "The git host reported a conflict.", { status });
  }
  if (status === 422) {
    if (message.includes("already exists") || message.includes("already_exists")) {
      return new GitHostError("conflict", "That already exists on the git host.", { status });
    }
    return new GitHostError("invalid_request", "The git host refused the request.", { status });
  }
  if (status >= 500) {
    return new GitHostError("host_unreachable", "The git host is not answering.", { status });
  }
  return new GitHostError("unexpected", "The git host gave an unexpected answer.", { status });
}

/** Rate-limit headers of an answer, when present. */
export function rateLimitOf(
  res: HostResponse,
  nowMs: number = Date.now(),
): { limit: number; remaining: number; resetAt: Date } | null {
  const limit = seconds(header(res, "x-ratelimit-limit"));
  const remaining = seconds(header(res, "x-ratelimit-remaining"));
  const reset = seconds(header(res, "x-ratelimit-reset"));
  if (limit === undefined || remaining === undefined || reset === undefined) return null;
  return { limit, remaining, resetAt: cappedResetAt(reset * 1000, nowMs) };
}
