/**
 * The provider-neutral git host adapter (spec workspace-git §3-§6, KOBE-758/759). One adapter
 * instance serves one connection: a host (base URL), one organization on it and one credential,
 * handed in unsealed by the caller. Adapters store nothing and never log; every method calls the
 * host through the shared address policy. Repository names are bare names inside the connection's
 * organization: an adapter never reaches another owner on the host.
 */

export type GitProvider = "github" | "gitea" | "forgejo";

export type GitAccess = "read" | "write";

/**
 * A credential value that does not leak through `JSON.stringify`, `String()` or `util.inspect`
 * (log lines, error dumps). Read it only where it is sent: `reveal()`.
 */
export class GitSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "GitSecret [redacted]";
  }
}

/** What the host is: product, version, and whether Kobe supports that version (GQ7). */
export interface GitHostProbe {
  readonly product: GitProvider;
  /** The version the host reports, as reported. */
  readonly version: string;
  readonly supported: boolean;
  /** The oldest supported version of this product, for the message when refused. */
  readonly minimumVersion: string;
  /** Newer than the newest version tested; accepted, shown as a note. */
  readonly newerThanTested: boolean;
}

export interface GitOrganization {
  /** The host's own id (stable across renames, G20). */
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly webUrl: string;
}

/** What the credential may do in the organization (G4). */
export interface GitAbilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly createRepositories: boolean;
  readonly administer: boolean;
}

export interface GitConnectionTest {
  readonly host: GitHostProbe;
  readonly organization: GitOrganization;
  /** The account the credential acts as (the bot or the token's owner, G6). */
  readonly actor: { readonly login: string; readonly siteAdministrator: boolean };
  readonly abilities: GitAbilities;
  /** Permissions beyond what a connection needs, named for the warning in G4. */
  readonly extraPermissions: readonly string[];
  /** When the credential lapses, if the host reports it (G6); null when it does not. */
  readonly credentialExpiresAt: Date | null;
  /** Notes for the admin, e.g. the provider chosen differs from the product detected. */
  readonly notes: readonly string[];
}

export interface GitRepository {
  readonly id: string;
  /** Bare name inside the organization. */
  readonly name: string;
  /** `organization/name`. */
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  /** True for a repository with no commits yet (G16 may use an existing empty one). */
  readonly empty: boolean;
  readonly archived: boolean;
  readonly webUrl: string;
  /** The git smart-HTTP clone URL. */
  readonly cloneUrl: string;
  /** What the credential may do in this repository, as the host reports it. */
  readonly permissions: {
    readonly read: boolean;
    readonly write: boolean;
    readonly admin: boolean;
  };
}

export interface GitPageRequest {
  /** Opaque cursor from a previous page; omitted for the first page. */
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface GitPage<T> {
  readonly items: readonly T[];
  /** Cursor of the next page, or null on the last one. */
  readonly nextCursor: string | null;
}

export interface GitCreateRepository {
  readonly name: string;
  readonly description?: string;
  /** Always private unless the admin allowed internal where the host has it (G10). */
  readonly visibility: "private" | "internal";
  readonly defaultBranch?: string;
  /** Create with an initial commit (a README) instead of empty. */
  readonly initialize?: boolean;
}

export interface GitPullRequestInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  /** Branch with the changes. */
  readonly head: string;
  /** Branch to merge into. */
  readonly base: string;
}

export interface GitPullRequest {
  readonly number: number;
  readonly title: string;
  readonly webUrl: string;
  readonly state: "open" | "closed" | "merged";
}

export interface GitIssueInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}

export interface GitIssue {
  readonly number: number;
  readonly title: string;
  readonly webUrl: string;
}

export interface GitCommentInput {
  readonly repository: string;
  /** Issue or pull request number. */
  readonly number: number;
  readonly body: string;
}

export interface GitComment {
  readonly id: string;
  readonly webUrl: string;
}

/**
 * A credential for git smart-HTTP to one repository (G11), for the egress proxy to add.
 * `narrowed` says whether the host itself limits it to that repository and access: when false
 * (a token connection) it is valid for everything the token may do, so the proxy must enforce the
 * organization path and the service (`git-upload-pack` for read, `git-receive-pack` for write).
 */
export interface GitTransportCredential {
  readonly repository: string;
  readonly access: GitAccess;
  /** The `Authorization` header value. */
  readonly authorization: GitSecret;
  readonly narrowed: boolean;
  /** When the proxy must stop using it; null when it does not expire on its own. */
  readonly expiresAt: Date | null;
}

export interface GitHostAdapter {
  readonly provider: GitProvider;
  /** Detects the product and version and decides support; needs no credential scope. */
  probe(): Promise<GitHostProbe>;
  /** The test run when connecting (G4); refuses an unsupported version. */
  testConnection(): Promise<GitConnectionTest>;
  getOrganization(): Promise<GitOrganization>;
  listRepositories(page?: GitPageRequest): Promise<GitPage<GitRepository>>;
  /** Existence, default branch and permissions; throws `not_found` when absent. */
  getRepository(name: string): Promise<GitRepository>;
  createRepository(input: GitCreateRepository): Promise<GitRepository>;
  openPullRequest(input: GitPullRequestInput): Promise<GitPullRequest>;
  comment(input: GitCommentInput): Promise<GitComment>;
  createIssue(input: GitIssueInput): Promise<GitIssue>;
  /** Checks the repository exists and the credential has `access` there, then returns it. */
  transportCredential(repository: string, access: GitAccess): Promise<GitTransportCredential>;
}
