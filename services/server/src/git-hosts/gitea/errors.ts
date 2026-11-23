import { GitHostError } from "../adapter.js";
import { header, type HostResponse } from "../http.js";

/**
 * Gitea/Forgejo answers mapped to the shared typed errors (KOBE-759). Messages are fixed text;
 * the host's message is read only to pick out a missing token scope, never copied in.
 */

/** Wait this long on a 429 without `Retry-After`. */
const DEFAULT_WAIT_S = 60;

/** `… required scope(s): [write:issue]` (older) or `… required scope(s), required=[write:issue] …`. */
const SCOPE_IN_MESSAGE = /required scope\(s\)[^[]{0,40}\[([a-z]+:[a-z_]+)/i;

function missingScopeOf(json: unknown): string | undefined {
  const message = (json as { message?: unknown } | undefined)?.message;
  if (typeof message !== "string") return undefined;
  return SCOPE_IN_MESSAGE.exec(message.slice(0, 1000))?.[1]?.toLowerCase();
}

/** `Retry-After` as seconds (delta or HTTP date), capped at a day. */
function retryAfterSeconds(res: HostResponse, nowMs: number): number | undefined {
  const raw = header(res, "retry-after")?.trim();
  if (!raw) return undefined;
  const s = /^\d{1,10}$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - nowMs) / 1000);
  return Number.isFinite(s) ? Math.min(Math.max(s, 1), 86_400) : undefined;
}

export function giteaError(res: HostResponse, nowMs: number): GitHostError {
  const status = res.status;
  switch (true) {
    case status === 401:
      return new GitHostError("auth_failed", "The git host rejected the credential.", {
        status,
        reason: "credential_rejected",
      });
    case status === 403: {
      const scope = missingScopeOf(res.json);
      return new GitHostError(
        "forbidden",
        scope
          ? `The access token lacks the scope ${scope}.`
          : "The credential lacks a permission this needs.",
        { status, ...(scope ? { missingPermission: scope } : {}) },
      );
    }
    case status === 404:
      return new GitHostError("not_found", "Not found in the connected organization.", { status });
    case status === 409:
      return new GitHostError("conflict", "That already exists on the git host.", { status });
    case status === 400 || status === 422:
      return new GitHostError("invalid_request", "The git host refused the request.", { status });
    case status === 429: {
      const wait = retryAfterSeconds(res, nowMs) ?? DEFAULT_WAIT_S;
      return new GitHostError("rate_limited", "The git host's rate limit was reached.", {
        status,
        resetAt: new Date(nowMs + wait * 1000),
      });
    }
    case status >= 500:
      return new GitHostError("host_unreachable", "The git host is not answering.", { status });
    default:
      return new GitHostError("unexpected", "The git host gave an unexpected answer.", { status });
  }
}
