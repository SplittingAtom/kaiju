import { sql } from "drizzle-orm";
import { z } from "zod";
import type { KaijuTx } from "../client.js";
import { findMatchingPattern, normalizeHost, parseDomainPattern } from "../egress/domain.js";
import { GIT_ALLOWED_HOSTS_MAX, GIT_BASE_URL_MAX } from "./types.js";

/**
 * The Site ceiling for Workspace git (KOBE-757, spec G3): a Site switch allowing Git connections
 * (on by default) and an optional limit on the hosts Workspaces may connect to. Stored as
 * `site_settings` rows; read on every check, so a change applies at once. The connection routes
 * (GIT-4) refuse a new connection, and every use refuses an existing one, with
 * {@link decideGitHost}. The host must also be reachable under the Site's egress rules (the shared
 * address policy checks that on every call).
 */
export const GIT_SITE_ENABLED_KEY = "git.connections_enabled";
export const GIT_SITE_ALLOWED_HOSTS_KEY = "git.allowed_hosts";

export interface GitSiteSettings {
  /** The Site switch (default on). */
  readonly enabled: boolean;
  /** Canonical host patterns (`github.com`, `*.example.com`); empty = any host. */
  readonly allowedHosts: readonly string[];
}

export const GIT_SITE_DEFAULTS: GitSiteSettings = Object.freeze({
  enabled: true,
  allowedHosts: Object.freeze([]) as readonly string[],
});

/** An admin-entered host list: egress-style patterns, canonicalized, unique, sorted. */
export const gitAllowedHostsSchema = z
  .array(z.string().max(300))
  .max(GIT_ALLOWED_HOSTS_MAX)
  .transform((raw, ctx) => {
    const out = new Set<string>();
    for (const entry of raw) {
      const parsed = parseDomainPattern(entry);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: `${entry.slice(0, 80)}: ${parsed.reason}` });
        return z.NEVER;
      }
      out.add(parsed.pattern);
    }
    return [...out].sort();
  });

function parseEnabled(value: string | undefined): boolean {
  // Default on only while no row exists; a stored value turns it on only when exactly "true"
  // (anything else fails closed, as an unreadable host list does).
  return value === undefined ? GIT_SITE_DEFAULTS.enabled : value === "true";
}

function parseHosts(value: string | undefined): readonly string[] {
  if (value === undefined) return GIT_SITE_DEFAULTS.allowedHosts;
  try {
    const parsed = gitAllowedHostsSchema.safeParse(JSON.parse(value));
    // A stored value that no longer parses limits to nothing rather than to everything.
    return parsed.success ? parsed.data : ["invalid.invalid"];
  } catch {
    return ["invalid.invalid"];
  }
}

/** The settings from their stored rows (`key` -> `value`). */
export function parseGitSiteSettings(rows: ReadonlyMap<string, string>): GitSiteSettings {
  return {
    enabled: parseEnabled(rows.get(GIT_SITE_ENABLED_KEY)),
    allowedHosts: parseHosts(rows.get(GIT_SITE_ALLOWED_HOSTS_KEY)),
  };
}

/** Reads the Site ceiling (`site_settings` is site-wide: no team needed). */
export async function readGitSiteSettings(db: Pick<KaijuTx, "execute">): Promise<GitSiteSettings> {
  const res = await db.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM public.site_settings
     WHERE key IN (${GIT_SITE_ENABLED_KEY}, ${GIT_SITE_ALLOWED_HOSTS_KEY})`);
  return parseGitSiteSettings(new Map(res.rows.map((r) => [r.key, r.value])));
}

export type GitBaseUrlResult =
  | { readonly ok: true; readonly baseUrl: string; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates and canonicalizes an admin-entered base URL (G1): https only; no user, password,
 * query or fragment; a host name (no IP literal: private addresses go through the Site's internal
 * targets by name); an optional port and path (Gitea and Forgejo may be served under a path).
 * Result: lowercase host, no trailing slash, e.g. `https://git.example.com/forgejo`.
 */
export interface GitBaseUrlOptions {
  /**
   * Accept plain `http:` too. Only for a server whose connector address policy allows HTTP (the
   * chart's development flag, and the test fakes); production URLs are https.
   */
  readonly allowHttp?: boolean;
}

export function parseGitBaseUrl(raw: string, options: GitBaseUrlOptions = {}): GitBaseUrlResult {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > GIT_BASE_URL_MAX) {
    return { ok: false, reason: "enter the host's https address" };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "enter the host's https address, e.g. https://github.com" };
  }
  const scheme = url.protocol === "http:" && options.allowHttp === true ? "http" : "https";
  if (url.protocol !== `${scheme}:`) return { ok: false, reason: "the address must use https" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "the address must not contain a user name or password" };
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { ok: false, reason: "the address must not contain a query or fragment" };
  }
  const host = normalizeHost(url.hostname);
  if (host === null) {
    return { ok: false, reason: "the address must name a host, not an IP address" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (/[\s?#]/.test(path) || path.includes("//") || /(^|\/)\.\.?(\/|$)/.test(path)) {
    return { ok: false, reason: "the address has an invalid path" };
  }
  const port = url.port === "" ? "" : `:${url.port}`;
  const baseUrl = `${scheme}://${host}${port}${path}`;
  if (baseUrl.length > GIT_BASE_URL_MAX) return { ok: false, reason: "the address is too long" };
  return { ok: true, baseUrl, host };
}

export type GitHostDecision =
  | { readonly ok: true; readonly baseUrl: string; readonly host: string }
  | {
      readonly ok: false;
      readonly code: "git_disabled" | "host_not_allowed" | "invalid_base_url";
      readonly message: string;
    };

/** Whether the Site allows a connection to `baseUrl` now (G3). */
export function decideGitHost(
  settings: GitSiteSettings,
  baseUrl: string,
  options: GitBaseUrlOptions = {},
): GitHostDecision {
  if (!settings.enabled) {
    return {
      ok: false,
      code: "git_disabled",
      message: "Git connections are turned off for this Site.",
    };
  }
  const parsed = parseGitBaseUrl(baseUrl, options);
  if (!parsed.ok) return { ok: false, code: "invalid_base_url", message: parsed.reason };
  if (
    settings.allowedHosts.length > 0 &&
    findMatchingPattern(new Set(settings.allowedHosts), parsed.host) === undefined
  ) {
    return {
      ok: false,
      code: "host_not_allowed",
      message: `This Site does not allow Git connections to ${parsed.host}.`,
    };
  }
  return { ok: true, baseUrl: parsed.baseUrl, host: parsed.host };
}
