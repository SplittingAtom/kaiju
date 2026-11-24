import { decideGitHost, type GitSiteSettings } from "@kaiju/db";
import { GitHostError } from "./adapter.js";

/**
 * The Site's decision to reach a git host (spec workspace-git G3; KOBE-757/758 review M1). An
 * adapter is built only from a {@link GitHostTarget}, and every request it sends ({@link
 * hostRequest} in `http.ts`) re-checks the actual request host against the same decision, so the
 * Site switch, the host limit (with its `*.` patterns) and the base URL rules (https, no IP
 * literal, no user, query or fragment) are enforced by one matcher: `decideGitHost()` in
 * `@kaiju/db`. There is no other host check in `git-hosts/`.
 *
 * A target is opaque: only {@link gitHostTarget} makes one (it is registered in a module-private
 * set, so a look-alike object is refused). Callers build a fresh target per operation (connection
 * test, tool call, transport credential, health check) from the Site settings read for it
 * (`readGitSiteSettings`), so turning Git off or narrowing the host list applies to the next call.
 */
declare const targetBrand: unique symbol;

export interface GitHostTarget {
  /** The canonical base URL the decision allowed (`parseGitBaseUrl`). */
  readonly baseUrl: string;
  /** Its host name (lowercase, punycode). */
  readonly host: string;
  readonly [targetBrand]: true;
}

interface TargetState {
  readonly settings: GitSiteSettings;
  readonly allowHttp: boolean;
}

const issued = new WeakMap<object, TargetState>();

/** github.com serves its REST API from api.github.com: the one host paired with another. */
const PAIRED_API_HOSTS: Readonly<Record<string, string>> = { "github.com": "api.github.com" };

export interface GitHostTargetOptions {
  /** The connector address policy's development flag: allow `http:` base URLs. */
  readonly allowHttp?: boolean;
}

/**
 * Decides `baseUrl` under the Site's settings now. Throws a {@link GitHostError}: `host_refused`
 * (reason `site_git_off` or `site_host_limit`) or `invalid_request` for a base URL the rules
 * refuse. Nothing is sent.
 */
export function gitHostTarget(
  settings: GitSiteSettings,
  baseUrl: string,
  options: GitHostTargetOptions = {},
): GitHostTarget {
  const allowHttp = options.allowHttp === true;
  const decision = decideGitHost(settings, baseUrl, { allowHttp });
  if (!decision.ok) throw refusal(decision.code);
  const target = { baseUrl: decision.baseUrl, host: decision.host } as GitHostTarget;
  issued.set(Object.freeze(target), { settings, allowHttp });
  return target;
}

function refusal(code: "git_disabled" | "host_not_allowed" | "invalid_base_url"): GitHostError {
  if (code === "git_disabled") {
    return new GitHostError("host_refused", "Git connections are turned off for this Site.", {
      reason: "site_git_off",
    });
  }
  if (code === "host_not_allowed") {
    return new GitHostError("host_refused", "This Site does not allow connections to that host.", {
      reason: "site_host_limit",
    });
  }
  return new GitHostError("invalid_request", "The git host URL is not valid.");
}

function stateOf(target: GitHostTarget): TargetState {
  const state = typeof target === "object" && target !== null ? issued.get(target) : undefined;
  if (state === undefined) {
    throw new GitHostError("host_refused", "No Site decision for this git host.", {
      reason: "no_site_decision",
    });
  }
  return state;
}

/** Throws unless `target` came from {@link gitHostTarget}. */
export function assertGitHostTarget(target: GitHostTarget): void {
  stateOf(target);
}

/**
 * Re-checks one request URL (the first and every redirect hop) with the same matcher: its host
 * must be the target's host, or the API host paired with it, and must pass `decideGitHost()`
 * under the settings of the decision.
 */
export function assertRequestHost(target: GitHostTarget, url: URL): void {
  const state = stateOf(target);
  const host = url.hostname.toLowerCase();
  if (host !== target.host && PAIRED_API_HOSTS[target.host] !== host) {
    throw new GitHostError("host_refused", "The request left the connected git host.", {
      reason: "other_host",
    });
  }
  // The paired API host is decided as the host it serves (the Site lists `github.com`).
  const decided = host === target.host ? url.host : target.host;
  const decision = decideGitHost(state.settings, `${url.protocol}//${decided}`, {
    allowHttp: state.allowHttp,
  });
  if (!decision.ok) throw refusal(decision.code);
}
