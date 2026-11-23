import { RedirectRefusedError, rawRequest } from "../connectors/oauth/http.js";
import { checkConnectorUrl, type ConnectorUrlPolicy } from "../connectors/url-policy.js";
import { GitHostError } from "./adapter.js";
import type { GitWireSend } from "./git-wire.js";
import { assertGitHostTarget, assertRequestHost, type GitHostTarget } from "./target.js";

/**
 * Outbound HTTP for git host adapters (spec workspace-git §9; KOBE-758), shared by every provider.
 * The base URL is admin input, so every request goes through the connectors' address policy: https
 * only (port 443 unless the chart allows more), every resolved address public unless the Site lists
 * it as an internal target (a self-hosted Gitea or Enterprise Server, G3), the connection pinned to
 * the checked address (DNS rebinding), time and size capped. A redirect is followed only on the
 * API's own origin and path (a renamed repository); any other hop is refused. Every request needs
 * the Site's decision ({@link GitHostTarget}, G3) and re-checks its host, and each redirect hop's,
 * against it before anything is sent.
 */
export interface GitHostNet {
  readonly policy: ConnectorUrlPolicy;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** The pinned request (tests may answer here instead of the network); default `rawRequest`. */
  readonly request?: typeof rawRequest;
  /**
   * Git smart-HTTP from the server (Convert to repo, KOBE-765; `git-wire.ts`): tests may answer
   * here after the checks; default the pinned `sendGitWire`.
   */
  readonly wire?: GitWireSend;
}

export const GIT_HOST_TIMEOUT_MS = 15_000;
/** A page of 100 repositories from GitHub is about 600 KB. */
export const GIT_HOST_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SAME_ORIGIN_HOPS = 3;
const USER_AGENT = "kobe-server";

export interface HostResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Parsed JSON; undefined when the body is empty or not JSON. */
  readonly json: unknown;
}

export interface HostRequestInit {
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** The first value of a response header. */
export function header(res: HostResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function checkTarget(net: GitHostNet, url: URL): Promise<void> {
  // The policy refuses a ?query (it is written for registered URLs): check origin and path.
  const checked = await checkConnectorUrl(`${url.origin}${url.pathname}`, net.policy);
  if (checked.ok) return;
  if (checked.code === "host_unresolvable") {
    throw new GitHostError("host_unreachable", "The git host name does not resolve.");
  }
  throw new GitHostError("host_refused", "The git host address is not allowed on this site.", {
    reason: checked.code,
  });
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The next hop when it stays on the API's origin and under its path; otherwise undefined. */
function sameOriginHop(location: string | undefined, from: URL, apiRoot: URL): URL | undefined {
  if (location === undefined) return undefined;
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return undefined;
  }
  const root = apiRoot.pathname.endsWith("/") ? apiRoot.pathname : `${apiRoot.pathname}/`;
  if (next.origin !== apiRoot.origin) return undefined;
  if (!(`${next.pathname}/`.startsWith(root) || root === "/")) return undefined;
  if (next.username !== "" || next.password !== "") return undefined;
  return next;
}

/**
 * One API request to a git host under the rules above. `target` is the Site's decision for the
 * connection; `apiRoot` is the API's base URL and the request URL must be on it. Throws {@link GitHostError} for transport failures; any HTTP status
 * is returned for the adapter to map.
 */
export async function hostRequest(
  net: GitHostNet,
  target: GitHostTarget,
  apiRoot: string,
  url: string,
  init: HostRequestInit,
): Promise<HostResponse> {
  assertGitHostTarget(target);
  const root = new URL(apiRoot);
  let next = new URL(url);
  if (next.origin !== root.origin) {
    throw new GitHostError("host_refused", "The request left the git host's API.");
  }
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...init.headers,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  for (let hop = 0; ; hop += 1) {
    assertRequestHost(target, next);
    await checkTarget(net, next);
    let res: Awaited<ReturnType<typeof rawRequest>>;
    try {
      res = await (net.request ?? rawRequest)(
        next,
        { policy: net.policy, timeoutMs: net.timeoutMs ?? GIT_HOST_TIMEOUT_MS },
        {
          method: init.method,
          headers,
          maxBytes: net.maxResponseBytes ?? GIT_HOST_MAX_RESPONSE_BYTES,
          ...(body === undefined ? {} : { body }),
        },
      );
    } catch (error) {
      if (error instanceof RedirectRefusedError) {
        const hopUrl = sameOriginHop(error.location, next, root);
        if (hopUrl !== undefined && init.method === "GET" && hop < MAX_SAME_ORIGIN_HOPS) {
          next = hopUrl;
          continue;
        }
        throw new GitHostError("host_refused", "The git host answered with a redirect.", {
          reason: "redirect",
        });
      }
      throw new GitHostError("host_unreachable", "The git host could not be reached.");
    }
    if (res.text === undefined) {
      throw new GitHostError("unexpected", "The git host's answer was too large.");
    }
    return { status: res.status, headers: res.headers, json: parseJson(res.text) };
  }
}
