/**
 * The git host provider adapter (spec workspace-git §3-§5, §9; KOBE-758). One interface for every
 * provider (GitHub incl. Enterprise Server, Gitea, Forgejo; later GitLab and others, §10): the
 * server calls the host's API through it for connection tests (G4), the git host tools (G9),
 * per-repository transport credentials for the egress proxy (G11) and Convert to repo (G16).
 *
 * An adapter is built per connection from a base URL, an organization and an unsealed credential
 * the caller passes in; it stores nothing and never logs. It confines itself to the connected
 * organization: a repository outside it is "not found". Every request goes through the shared
 * address policy (`git-hosts/http.ts`). Failures are a {@link GitHostError} with a fixed code and
 * a message that never carries a credential, URL query or response body.
 */

import type { GitCapabilities, GitCapability, GitCredentialKind, GitProvider } from "@kobe/db";

/**
 * The provider, credential kinds and capabilities are declared once, in `@kobe/db` (shared with
 * the `git_connections` table, which stores probe capabilities as they are); re-exported here for
 * the adapters' convenience.
 */
export type { GitCapabilities, GitCapability, GitCredentialKind, GitProvider };

/** Read (fetch, read tools) or read and write (push, write tools). */
export type GitAccess = "read" | "write";

export interface GitOrganization {
  /** The host's stable id. */
  readonly id: string;
  readonly login: string;
  readonly name: string | null;
  /** An organization, or a user namespace (G1). */
  readonly kind: "organization" | "user";
  readonly webUrl: string;
}

export interface GitRepository {
  /** The host's stable id: renames and transfers keep it (G20). */
  readonly id: string;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly visibility: "private" | "internal" | "public";
  /** Null while the repository has no branch yet. */
  readonly defaultBranch: string | null;
  readonly archived: boolean;
  /** True when the repository has no commits (Convert to repo may push into it, G16). */
  readonly empty: boolean;
  /**
   * The repository's description as the host reports it (at most 512 characters; null when none).
   * Convert to repo writes a marker into it, so an interrupted attempt recognises the repository
   * it created (KOBE-765). Untrusted host text: never shown as markup or passed to a model.
   */
  readonly description?: string | null;
  readonly webUrl: string;
  /** The smart-HTTP clone URL, built by {@link cloneUrlFor} (`<base>/<org>/<name>.git`). */
  readonly cloneUrl: string;
}

/** A repository by name in the connected organization, or by the host's id. */
export type GitRepositoryRef = { readonly name: string } | { readonly id: string };

export interface GitPage<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page; null on the last page. */
  readonly next: string | null;
}

export interface GitRateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

/** The result of testing a connection (G4) and of the health check (§7). */
export interface GitHostProbe {
  readonly provider: GitProvider;
  readonly organization: GitOrganization;
  /** The host's version where it reports one (Enterprise Server, Gitea, Forgejo). */
  readonly hostVersion: string | null;
  /** Who actions appear as on the host: an app's bot or the token's owner (G5, G6). */
  readonly actor: { readonly kind: "app" | "token"; readonly login: string | null };
  readonly capabilities: GitCapabilities;
  /** Permissions the credential holds beyond what the connection needs, by the host's names (G4). */
  readonly excess: readonly string[];
  /** The credential's own expiry when the host reports one (G6); null for an app or no expiry. */
  readonly credentialExpiresAt: Date | null;
  readonly rateLimit: GitRateLimit | null;
}

/** A credential for git smart-HTTP to one repository, added by the egress proxy (G11). */
export interface GitRepositoryCredential {
  /** HTTP Basic user name and password. Never logged, stored or returned by an API. */
  readonly username: string;
  readonly password: string;
  /** When it stops working; null for a static token without a reported expiry. */
  readonly expiresAt: Date | null;
  readonly access: GitAccess;
  /**
   * True when the host itself limits the credential to this repository and access (a GitHub App
   * installation token). False for a static token valid for everything it may do (a GitHub
   * fine-grained token, a Gitea/Forgejo token): the egress proxy must then enforce the
   * organization path and read or write per service (G11). Required, so no adapter omits it.
   */
  readonly narrowed: boolean;
}

export interface GitCreateRepositoryInput {
  readonly name: string;
  readonly description?: string;
  /** Never public (G10); internal only where the host has it and the admin allowed it. */
  readonly visibility: "private" | "internal";
}

export interface GitOpenPullRequestInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  /** The branch with the changes. */
  readonly head: string;
  /** The branch to merge into. */
  readonly base: string;
  readonly draft?: boolean;
}

export interface GitCommentInput {
  readonly repository: string;
  /** Issue or pull request number. */
  readonly number: number;
  readonly on: "issue" | "pull_request";
  readonly body: string;
}

export interface GitCreateIssueInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}

/** A created pull request, issue or comment. */
export interface GitCreated {
  readonly id: string;
  /** Pull request or issue number; null for a comment. */
  readonly number: number | null;
  readonly webUrl: string;
}

export interface GitHostAdapter {
  readonly provider: GitProvider;
  /** Tests the connection: organization, capabilities, excess permissions, expiry, version. */
  probe(): Promise<GitHostProbe>;
  describeOrganization(): Promise<GitOrganization>;
  /** One page of the organization's repositories the credential can see. */
  listRepositories(options?: {
    readonly cursor?: string | null;
    readonly perPage?: number;
  }): Promise<GitPage<GitRepository>>;
  /** A repository of the organization (existence, default branch); not found outside it. */
  getRepository(ref: GitRepositoryRef): Promise<GitRepository>;
  createRepository(input: GitCreateRepositoryInput): Promise<GitRepository>;
  /** A transport credential for one repository, narrowed to read or write where the host can. */
  repositoryCredential(repository: string, access: GitAccess): Promise<GitRepositoryCredential>;
  openPullRequest(input: GitOpenPullRequestInput): Promise<GitCreated>;
  comment(input: GitCommentInput): Promise<GitCreated>;
  createIssue(input: GitCreateIssueInput): Promise<GitCreated>;
}

export type GitHostErrorCode =
  /** The credential was rejected: expired, revoked, removed installation, bad key. */
  | "auth_failed"
  | "not_found"
  /** The credential lacks a permission; `missingPermission` names it when the host says. */
  | "forbidden"
  /** Primary or secondary rate limit; `resetAt` says when to try again. */
  | "rate_limited"
  /** The thing to create already exists (repository name taken, pull request open). */
  | "conflict"
  /** The host refused the input, or Kobe did before sending (bad name, internal not offered). */
  | "invalid_request"
  /** The address policy, a redirect to elsewhere or the Site's host limit refused the host. */
  | "host_refused"
  /** No answer: DNS, connect, TLS, timeout, 5xx. */
  | "host_unreachable"
  /** The host's version or kind is not supported. */
  | "unsupported_host"
  | "unexpected";

/** Why `auth_failed`, where the adapter can tell. */
export type GitAuthFailure =
  "credential_rejected" | "installation_removed" | "installation_suspended" | "invalid_private_key";

/**
 * A permission name a host reported missing, kept only when it looks like one (review L2): known
 * characters, at most 120 of them; otherwise omitted. Never host prose.
 */
export function safePermissionName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "" || value.length > 120 || !/^[a-z0-9_:=;, -]+$/.test(value)) return undefined;
  return value;
}

/** The latest a host's rate-limit reset is believed: a day ahead (review L3). */
export const MAX_RATE_LIMIT_WAIT_MS = 86_400_000;

/** A reset time capped to {@link MAX_RATE_LIMIT_WAIT_MS} after `nowMs`. */
export function cappedResetAt(resetMs: number, nowMs: number): Date {
  return new Date(Math.min(Math.max(resetMs, nowMs), nowMs + MAX_RATE_LIMIT_WAIT_MS));
}

export interface GitHostErrorDetails {
  readonly status?: number;
  readonly missingPermission?: string;
  readonly resetAt?: Date;
  readonly reason?: GitAuthFailure | string;
}

/** A git host failure. The message is fixed text: never a credential, URL query or body. */
export class GitHostError extends Error {
  readonly status: number | undefined;
  readonly missingPermission: string | undefined;
  readonly resetAt: Date | undefined;
  readonly reason: string | undefined;
  constructor(
    readonly code: GitHostErrorCode,
    message: string,
    details: GitHostErrorDetails = {},
  ) {
    super(message);
    this.name = "GitHostError";
    this.status = details.status;
    // Host-supplied: kept only when it looks like a permission name (review L2).
    this.missingPermission = safePermissionName(details.missingPermission);
    this.resetAt = details.resetAt;
    this.reason = details.reason;
  }
}

/** Repository names Kobe sends to a host: one path segment, never `.` or `..` (§9). */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function assertRepositoryName(name: string): string {
  if (!REPOSITORY_NAME.test(name) || name === "." || name === ".." || name.endsWith(".git")) {
    throw new GitHostError("invalid_request", "That is not a valid repository name.");
  }
  return name;
}

const BRANCH = /^[^\s:~^?*[\\]{1,255}$/;

/** Branch names Kobe sends: no `owner:branch` (a fork outside the organization), no `..`. */
export function assertBranch(name: string): string {
  if (!BRANCH.test(name) || name.includes("..") || name.startsWith("-")) {
    throw new GitHostError("invalid_request", "That is not a valid branch name.");
  }
  return name;
}

export function assertNumber(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new GitHostError("invalid_request", "That is not a valid issue or pull request number.");
  }
  return n;
}

/** Page cursors are page numbers as text, for every provider that pages by number. */
export function cursorPage(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) return 1;
  if (!/^\d{1,6}$/.test(cursor) || Number(cursor) < 1) {
    throw new GitHostError("invalid_request", "That is not a valid page cursor.");
  }
  return Number(cursor);
}

/**
 * A web link the host returned (`html_url`), kept only when it is on the connection's own web
 * origin, with its scheme, under its base path (review M2): anything else (`javascript:`, another
 * host, another port, a scheme change) is dropped to "" rather than shown or followed.
 */
export function safeWebUrl(raw: unknown, webBase: string): string {
  if (typeof raw !== "string" || raw.length > 2048) return "";
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(webBase);
  } catch {
    return "";
  }
  if (url.origin !== base.origin || url.protocol !== base.protocol) return "";
  if (url.username !== "" || url.password !== "") return "";
  const root = base.pathname.replace(/\/+$/, "");
  if (root !== "" && url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return "";
  return url.href;
}

/**
 * The smart-HTTP clone URL of a repository of the connected organization, built from the
 * validated base URL, never taken from the host's answer (review M2): `<web base>/<org>/<name>.git`.
 */
export function cloneUrlFor(webBase: string, organization: string, name: string): string {
  const base = webBase.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(organization)}/${encodeURIComponent(assertRepositoryName(name))}.git`;
}
