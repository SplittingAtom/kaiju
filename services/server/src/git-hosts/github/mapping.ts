import type { GitCapabilities, GitCapability } from "@kobe/db";
import {
  cloneUrlFor,
  GitHostError,
  safeWebUrl,
  type GitOrganization,
  type GitRepository,
} from "../adapter.js";

/**
 * GitHub's base URLs and JSON mapped to the adapter's types (KOBE-758).
 */

const GITHUB_COM_HOSTS = new Set(["github.com", "www.github.com", "api.github.com"]);

/** Organization and user logins: GitHub's rule (alphanumerics and single inner hyphens, 39). */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function assertGithubLogin(login: string): string {
  if (!GITHUB_LOGIN.test(login)) {
    throw new GitHostError("invalid_request", "That is not a valid GitHub organization name.");
  }
  return login;
}

/**
 * The web base URL and the REST API root for a connection's base URL: `https://github.com` uses
 * `https://api.github.com`; an Enterprise Server at `https://ghe.example` uses
 * `https://ghe.example/api/v3`. A trailing `/api/v3` the admin pasted is accepted.
 */
export function githubUrls(baseUrl: string): { webBase: string; apiRoot: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GitHostError("invalid_request", "The git host URL is not valid.");
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new GitHostError("invalid_request", "The git host URL must be a plain base URL.");
  }
  const host = url.hostname.toLowerCase();
  if (GITHUB_COM_HOSTS.has(host)) {
    return { webBase: "https://github.com", apiRoot: "https://api.github.com" };
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
  const webBase = `${url.origin}${path}`;
  return { webBase, apiRoot: `${webBase}/api/v3` };
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null =>
  typeof v === "number" || typeof v === "string" ? String(v) : null;

export function ownerLogin(json: unknown): string | null {
  const owner = (json as Json | undefined)?.owner as Json | undefined;
  return str(owner?.login);
}

/** A host's repository description, kept only as bounded text (KOBE-765). */
export function descriptionOf(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw.slice(0, 512) : null;
}

/**
 * A repository answer of the connected organization (the caller confined it). `webUrl` only on the
 * connection's web origin; `cloneUrl` built from the base URL, never from the answer (review M2).
 */
export function toRepository(json: unknown, webBase: string, organization: string): GitRepository {
  const r = (json ?? {}) as Json;
  const id = idOf(r.id);
  const name = str(r.name);
  const fullName = str(r.full_name);
  if (id === null || name === null || fullName === null || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new GitHostError("unexpected", "GitHub returned a repository without its fields.");
  }
  const visibility = str(r.visibility);
  return {
    id,
    name,
    fullName,
    visibility:
      visibility === "internal" || visibility === "public" || visibility === "private"
        ? visibility
        : r.private === false
          ? "public"
          : "private",
    defaultBranch: str(r.default_branch),
    archived: r.archived === true,
    // GitHub has no "empty" flag; a repository without commits reports size 0.
    empty: r.size === 0,
    description: descriptionOf(r.description),
    webUrl: safeWebUrl(r.html_url, webBase),
    cloneUrl: cloneUrlFor(webBase, organization, name),
  };
}

export function toOrganization(
  json: unknown,
  kind: "organization" | "user",
  webBase: string,
): GitOrganization {
  const o = (json ?? {}) as Json;
  const id = idOf(o.id);
  const login = str(o.login);
  if (id === null || login === null) {
    throw new GitHostError("unexpected", "GitHub returned an organization without its fields.");
  }
  return { id, login, name: str(o.name), kind, webUrl: safeWebUrl(o.html_url, webBase) };
}

/** Permissions Kobe may ask an App for (G5); anything else granted is reported as excess (G4). */
export const APP_PERMISSIONS_USED = new Set([
  "metadata",
  "contents",
  "pull_requests",
  "issues",
  "administration",
]);

/** Capabilities and excess from an App installation's granted permissions. */
export function appCapabilities(
  permissions: Readonly<Record<string, unknown>>,
  accountType: "organization" | "user",
): { capabilities: GitCapabilities; excess: string[] } {
  const level = (k: string) => str(permissions[k]);
  const yes = (b: boolean): GitCapability => (b ? "yes" : "no");
  const contents = level("contents");
  const capabilities: GitCapabilities = {
    create: yes(accountType === "organization" && level("administration") === "write"),
    read: yes(contents === "read" || contents === "write"),
    write: yes(contents === "write" && level("pull_requests") === "write"),
    admin: yes(level("organization_administration") === "write"),
  };
  const excess = Object.entries(permissions)
    .filter(([k]) => !APP_PERMISSIONS_USED.has(k))
    .map(([k, v]) => `${k}:${String(v)}`)
    .sort();
  return { capabilities, excess };
}

/** Classic token scopes Kobe's work needs; any other granted scope is excess (G4). */
const CLASSIC_SCOPES_USED = new Set(["repo", "read:org", "read:user"]);

/** Capabilities and excess from a classic token's `x-oauth-scopes`. */
export function classicCapabilities(scopesHeader: string): {
  capabilities: GitCapabilities;
  excess: string[];
} {
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const has = (s: string) => scopes.includes(s);
  const repo = has("repo");
  return {
    capabilities: {
      create: repo ? "unknown" : "no",
      read: repo || has("public_repo") ? "yes" : "no",
      write: repo ? "yes" : "no",
      admin: has("admin:org") || has("write:org") ? "yes" : "no",
    },
    // A classic token reaches every repository its owner can: flag the kind itself too.
    excess: [
      "classic_token",
      ...scopes.filter((s) => !CLASSIC_SCOPES_USED.has(s)).map((s) => `scope:${s}`),
    ].sort(),
  };
}

/**
 * The token's expiry from `github-authentication-token-expiration` (`2026-12-31 00:00:00 UTC`
 * or `... +0000`); null when absent or unreadable.
 */
export function tokenExpiry(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|([+-]\d{2})(\d{2}))$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const offset = m[3] === undefined ? "Z" : `${m[3]}:${m[4]}`;
  const d = new Date(`${m[1]}T${m[2]}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The next page number from a `Link` header, when there is a `rel="next"`. */
export function nextPage(link: string | undefined): number | null {
  if (link === undefined) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!m?.[1]) continue;
    try {
      const page = Number(new URL(m[1]).searchParams.get("page"));
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}
