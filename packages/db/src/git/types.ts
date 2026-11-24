/**
 * Workspace git (KOBE-757, spec docs/specs/workspace-git.md §3, §4, §8): the shared vocabulary of
 * git connections and repositories. The provider adapters (GIT-2, GIT-3), the connection routes
 * (GIT-4) and the egress proxy (GIT-7) import these from `@kobe/db`; the tables are in
 * `schema/git.ts`, the sealed credential in `git/credential.ts`, the Site ceiling in
 * `git/site-settings.ts`.
 */

/**
 * Git hosts Kaiju connects to (G1). GitHub Enterprise Server is `github` with its own base URL
 * (GQ6: the same adapter); Forgejo is a fork of Gitea and shares its adapter, but is recorded so
 * labels, links and documentation are right (G7).
 */
export const GIT_PROVIDER_VALUES = ["github", "gitea", "forgejo"] as const;
export type GitProvider = (typeof GIT_PROVIDER_VALUES)[number];

/**
 * How a connection authenticates (§4): a GitHub App installation (G5, GitHub only: App ID and
 * installation ID in clear, the private key sealed) or an access token (G6: a fine-grained
 * personal access token on GitHub, a bot account's token on Gitea and Forgejo; sealed).
 */
export const GIT_CREDENTIAL_KIND_VALUES = ["github_app", "access_token"] as const;
export type GitCredentialKind = (typeof GIT_CREDENTIAL_KIND_VALUES)[number];

/** The credential kinds each provider accepts (G7: Gitea and Forgejo have no apps). */
export const GIT_CREDENTIAL_KINDS_BY_PROVIDER: Readonly<
  Record<GitProvider, readonly GitCredentialKind[]>
> = {
  github: ["github_app", "access_token"],
  gitea: ["access_token"],
  forgejo: ["access_token"],
};

/** Access level of a connection (G1): the same three steps as the Kaiju admin connector. */
export const GIT_ACCESS_LEVEL_VALUES = ["off", "read", "read_write"] as const;
export type GitAccessLevel = (typeof GIT_ACCESS_LEVEL_VALUES)[number];

/** Visibility of repositories agents create (G10): never public. */
export const GIT_REPO_VISIBILITY_VALUES = ["private", "internal"] as const;
export type GitRepoVisibility = (typeof GIT_REPO_VISIBILITY_VALUES)[number];

/** How a repository row came to be (§7 Repositories): a tool call, a conversion (G16), a relink (G20). */
export const GIT_REPOSITORY_ORIGIN_VALUES = ["tool", "conversion", "link"] as const;
export type GitRepositoryOrigin = (typeof GIT_REPOSITORY_ORIGIN_VALUES)[number];

/**
 * The repository on the host as Kaiju last saw it (G20): `active`; `archived` or `deleted` on the
 * host (a Repo becomes read-only from its mirror); `unreachable`: the connection was removed or
 * cannot reach it.
 */
export const GIT_REPOSITORY_HOST_STATE_VALUES = [
  "active",
  "archived",
  "deleted",
  "unreachable",
] as const;
export type GitRepositoryHostState = (typeof GIT_REPOSITORY_HOST_STATE_VALUES)[number];

/** A project's kind (G15, §8): an ordinary Kaiju project, or a Repo whose record is on the host. */
export const PROJECT_KIND_VALUES = ["project", "repo"] as const;
export type ProjectKind = (typeof PROJECT_KIND_VALUES)[number];

/** Connections per Workspace (G2, GQ1). The connection routes (GIT-4) enforce it. */
export const GIT_CONNECTIONS_MAX = 5;
/** The default base URL (G1). */
export const GIT_DEFAULT_BASE_URL = "https://github.com";
/** Default push size limit per connection (G11): 1 GiB. */
export const GIT_PUSH_LIMIT_DEFAULT_BYTES = 1024 * 1024 * 1024;
/** Upper bound an admin may set for the push size limit: 10 GiB. */
export const GIT_PUSH_LIMIT_MAX_BYTES = 10 * 1024 * 1024 * 1024;
/** Agents a connection may be limited to (GQ8); null on the row means every agent. */
export const GIT_CONNECTION_AGENTS_MAX = 50;

/** Host patterns a Site admin may list in the Site's host limit (G3). */
export const GIT_ALLOWED_HOSTS_MAX = 50;

/** Field limits, shared by the table checks and the route validation. */
export const GIT_BASE_URL_MAX = 2048;
export const GIT_ORGANIZATION_MAX = 100;
export const GIT_DISPLAY_NAME_MAX = 100;
export const GIT_REPO_NAME_PREFIX_MAX = 40;
export const GIT_BRANCH_NAME_MAX = 100;
export const GIT_CREDENTIAL_HINT_MAX = 16;
/** Longest sealed envelope text stored (a GitHub App private key of a few KB, wrapped, base64url). */
export const GIT_CREDENTIAL_SEALED_MAX = 16384;
/** Short machine code of the last failed health check (never a host's message text). */
export const GIT_HEALTH_ERROR_MAX = 64;
export const GIT_REPOSITORY_NAME_MAX = 100;

/**
 * An organization or owner name (G1). GitHub allows letters, digits and hyphens; Gitea and Forgejo
 * also dots and underscores. Compared without case (both hosts treat names that way).
 */
export const GIT_ORGANIZATION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
/** A repository name on any of the hosts (no slash; `.git` is never part of it). */
export const GIT_REPOSITORY_NAME_PATTERN = "^[A-Za-z0-9._-]+$";
/** An optional prefix for new repository names (G1 defaults), e.g. `kobe-`. */
export const GIT_REPO_NAME_PREFIX_PATTERN = "^[A-Za-z0-9._-]*$";
/** A default branch name: a conservative subset of git's ref rules. */
export const GIT_BRANCH_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]*$";

/** A capability the credential may have (G4); `unknown` when the host cannot say without trying. */
export const GIT_CAPABILITY_VALUES = ["yes", "no", "unknown"] as const;
export type GitCapability = (typeof GIT_CAPABILITY_VALUES)[number];

/**
 * What the credential may do in the organization (G4), as a connection test (the adapters'
 * `probe()`) found it. Stored on the connection (`git_connections.capabilities`, validated by
 * `gitCapabilitiesSchema` on write and read) and shown in the Git section.
 */
export interface GitCapabilities {
  /** Create repositories in the organization. */
  readonly create: GitCapability;
  /** Read repositories' contents. */
  readonly read: GitCapability;
  /** Push and open pull requests, issues and comments. */
  readonly write: GitCapability;
  /** Administer repositories or the organization (more than Kaiju needs). */
  readonly admin: GitCapability;
}

/** Before the first test: nothing known. */
export const GIT_CAPABILITIES_UNKNOWN: GitCapabilities = Object.freeze({
  create: "unknown",
  read: "unknown",
  write: "unknown",
  admin: "unknown",
});

/** Permissions beyond what the connection needs (G4), by the host's names; at most this many. */
export const GIT_EXCESS_PERMISSIONS_MAX = 50;
export const GIT_EXCESS_PERMISSION_MAX_LENGTH = 100;

/**
 * A `git_connections` row without its sealed credential: what server code passes around and the
 * consoles may show. The credential is only ever read by `openGitCredential()` for one call.
 */
export interface GitConnectionRecord {
  readonly teamId: string;
  readonly id: string;
  readonly provider: GitProvider;
  /** Canonical https base URL (`parseGitBaseUrl`), no trailing slash. */
  readonly baseUrl: string;
  readonly organization: string;
  readonly displayName: string;
  readonly credentialKind: GitCredentialKind;
  /** GitHub App ID and installation ID (G5); null for tokens. Not secret. */
  readonly githubAppId: number | null;
  readonly githubInstallationId: number | null;
  /** Masked hint of an access token (last characters), safe to show admins; null for apps. */
  readonly credentialHint: string | null;
  readonly accessLevel: GitAccessLevel;
  readonly repoVisibility: GitRepoVisibility;
  readonly repoNamePrefix: string;
  readonly defaultBranch: string;
  readonly pushLimitBytes: number;
  /** G18, GQ11: commits from Kaiju's flow may go straight to the default branch. */
  readonly directCommits: boolean;
  /** GQ8: the agents that may use it; null = every agent in the Workspace. */
  readonly agentIds: readonly string[] | null;
  readonly capabilities: GitCapabilities;
  /** Permissions the credential holds beyond what the connection needs (G4; the console warns). */
  readonly excessPermissions: readonly string[];
  readonly lastCheckedAt: Date | null;
  readonly lastOkAt: Date | null;
  readonly lastError: string | null;
  /** Token expiry when the host reports one (G6). */
  readonly credentialExpiresAt: Date | null;
  readonly expiryNotifiedAt: Date | null;
  readonly createdBy: string;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly credentialUpdatedAt: Date;
}

/** A `git_repositories` row (§8). */
export interface GitRepositoryRecord {
  readonly teamId: string;
  readonly id: string;
  /** Null once the connection was removed (G20: the Repo stays, read-only). */
  readonly connectionId: string | null;
  /** The host's base URL (as the connection's): with `hostRepoId`, the repository's identity. */
  readonly baseUrl: string;
  /** The host's own id (G20: Kaiju follows it through renames and transfers). */
  readonly hostRepoId: string;
  /** `organization/repository` as last seen on the host. */
  readonly fullName: string;
  readonly defaultBranch: string;
  /** Set for a Repo (G15): the project whose record this repository is. */
  readonly projectId: string | null;
  readonly origin: GitRepositoryOrigin;
  readonly hostState: GitRepositoryHostState;
  readonly isPrivate: boolean;
  /** G14: whether the default branch is protected; null until read. */
  readonly defaultBranchProtected: boolean | null;
  /** G17: the mirrored head of the default branch and when it was last refreshed. */
  readonly mirrorHeadSha: string | null;
  readonly mirrorRefreshedAt: Date | null;
  /** KOBE-766: the Kaiju commit the mirror last wrote (null while the head is Kaiju's own). */
  readonly mirrorCommitId: string | null;
  /** KOBE-766: the last refresh attempt, its failure code, failures in a row and the backoff. */
  readonly mirrorAttemptedAt: Date | null;
  readonly mirrorError: string | null;
  readonly mirrorFailures: number;
  readonly mirrorNextAt: Date | null;
  /** KOBE-766: a push or an open asked for a refresh at this time (the timer takes it soon). */
  readonly mirrorRequestedAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The Repo mirror (KOBE-766, G17, G20): the host's commit list of the mirrored default branch is
 * kept newest first, at most this many commits (`git_repository_commits`); older history is on
 * the host. Field limits of one listed commit (untrusted host text, shown as plain text only).
 */
export const GIT_MIRROR_LOG_MAX = 25;
export const GIT_MIRROR_AUTHOR_MAX = 200;
export const GIT_MIRROR_MESSAGE_MAX = 500;
/** Short machine code of the last failed mirror refresh (never a host's message text). */
export const GIT_MIRROR_ERROR_MAX = 64;

/**
 * Convert to repo (KOBE-765, G16): a conversion's status. `running` while the job works (or waits
 * to be resumed after a restart); `failed` after a step failed, until a person retries or
 * abandons it; `completed` once the project is a Repo; `abandoned` when a person gave up on a
 * failed attempt (the project stays an ordinary project). While a conversion is `running` or
 * `failed` the project takes no Kaiju commits, and it has at most one such conversion.
 */
export const GIT_CONVERSION_STATUS_VALUES = [
  "running",
  "failed",
  "completed",
  "abandoned",
] as const;
export type GitConversionStatus = (typeof GIT_CONVERSION_STATUS_VALUES)[number];
/** The statuses that hold the project (one per project; Kaiju commits refused). */
export const GIT_CONVERSION_ACTIVE_STATUSES = ["running", "failed"] as const;

/**
 * The next step of a conversion (G16): `create` the repository on the host (or adopt the chosen
 * empty one), `push` the history, `finish` (verify the host's branch, then mark the project a Repo
 * and link it in one transaction), `done`.
 */
export const GIT_CONVERSION_STEP_VALUES = ["create", "push", "finish", "done"] as const;
export type GitConversionStep = (typeof GIT_CONVERSION_STEP_VALUES)[number];
