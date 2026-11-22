import { RedirectRefusedError, rawRequest } from "../connectors/oauth/http.js";
import { checkConnectorUrl, type ConnectorUrlPolicy } from "../connectors/url-policy.js";
import { GitHostError } from "./provider-errors.js";

/**
 * Outbound HTTP to a git host's API (spec workspace-git §9, KOBE-759). The base URL is admin
 * supplied, so every call passes the shared address policy (the connectors' SSRF guard): https
 * only, allowed ports only, every resolved address public unless the Site lists that target among
 * its internal targets (a self-hosted host on a private network, G3), the connection pinned to the
 * checked address (DNS rebinding), redirects never followed, time and size capped. The Site's
 * host limit (G3) is checked first. Failures are {@link GitHostError}s that never carry a URL,
 * header, token or body.
 */
export interface GitHostNet {
  readonly policy: ConnectorUrlPolicy;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** The Site's limit on git hosts (G3), given the lowercased host name; absent: any host. */
  readonly isHostAllowed?: (hostname: string) => boolean;
  /** The pinned request (tests may answer here instead of the network); default `rawRequest`. */
  readonly request?: typeof rawRequest;
}

export const GIT_HOST_TIMEOUT_MS = 15_000;
/** A page of 50 repositories is ~250 KB on Gitea; 2 MiB leaves room without buffering much. */
export const GIT_HOST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GitHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body; undefined when empty or not JSON. */
  readonly json: unknown;
}

export interface GitHttpInit {
  readonly method: "GET" | "POST";
  readonly headers?: Record<string, string>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GitHostError("host_unreachable")), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** Checks the URL (without its query, which the policy refuses) against the policy and limit. */
async function checkTarget(net: GitHostNet, url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isHostAllowed && !net.isHostAllowed(host)) throw new GitHostError("host_not_allowed");
  const bare = new URL(url.toString());
  bare.search = "";
  const checked = await checkConnectorUrl(bare.toString(), net.policy);
  if (checked.ok) return;
  throw new GitHostError(
    checked.code === "host_unresolvable" ? "host_unreachable" : "host_not_allowed",
  );
}

function transportFailure(error: unknown): GitHostError {
  if (error instanceof GitHostError) return error;
  if (error instanceof RedirectRefusedError) return new GitHostError("host_not_allowed");
  // The pinned lookup refuses an address that re-resolved outside the policy.
  if (error instanceof Error && error.message === "address not allowed") {
    return new GitHostError("host_not_allowed");
  }
  return new GitHostError("host_unreachable");
}

/** One JSON request to the git host under {@link GitHostNet}; one deadline covers it all. */
export async function gitHostRequest(
  net: GitHostNet,
  url: URL,
  init: GitHttpInit,
): Promise<GitHttpResponse> {
  const startedAt = Date.now();
  await withDeadline(checkTarget(net, url), net.timeoutMs);
  const remaining = Math.max(1, net.timeoutMs - (Date.now() - startedAt));
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  let res: Awaited<ReturnType<typeof rawRequest>>;
  try {
    res = await (net.request ?? rawRequest)(
      url,
      { policy: net.policy, timeoutMs: remaining, maxBodyBytes: net.maxResponseBytes },
      {
        method: init.method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(body === undefined ? {} : { body }),
      },
    );
  } catch (error) {
    throw transportFailure(error);
  }
  if (res.text === undefined) throw new GitHostError("unexpected", { status: res.status });
  let json: unknown;
  try {
    json = res.text === "" ? undefined : JSON.parse(res.text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

/** A header's first value. */
export function headerOf(res: GitHttpResponse, name: string): string | undefined {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** `Retry-After` as whole seconds (delta or HTTP date), capped at a day; undefined if absent. */
export function retryAfterSeconds(res: GitHttpResponse, now = Date.now()): number | undefined {
  const raw = headerOf(res, "retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - now) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 0), 86_400);
}

/** Whether a `Link` header announces a next page. */
export function hasNextLink(res: GitHttpResponse): boolean {
  const link = headerOf(res, "link");
  return link !== undefined && /;\s*rel="?next"?/i.test(link);
}
