import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  GIT_ACCESS_LEVEL_VALUES,
  GIT_BASE_URL_MAX,
  GIT_BRANCH_NAME_MAX,
  GIT_BRANCH_NAME_PATTERN,
  GIT_CONNECTION_AGENTS_MAX,
  GIT_CREDENTIAL_HINT_MAX,
  GIT_CREDENTIAL_KIND_VALUES,
  GIT_CREDENTIAL_SEALED_MAX,
  GIT_DISPLAY_NAME_MAX,
  GIT_HEALTH_ERROR_MAX,
  GIT_ORGANIZATION_MAX,
  GIT_ORGANIZATION_PATTERN,
  GIT_PROVIDER_VALUES,
  GIT_PUSH_LIMIT_DEFAULT_BYTES,
  GIT_PUSH_LIMIT_MAX_BYTES,
  GIT_REPO_NAME_PREFIX_MAX,
  GIT_REPO_NAME_PREFIX_PATTERN,
  GIT_REPO_VISIBILITY_VALUES,
  GIT_REPOSITORY_HOST_STATE_VALUES,
  GIT_REPOSITORY_NAME_MAX,
  GIT_REPOSITORY_ORIGIN_VALUES,
  type GitAccessLevel,
  type GitCapabilities,
  type GitCredentialKind,
  type GitProvider,
  type GitRepoVisibility,
  type GitRepositoryHostState,
  type GitRepositoryOrigin,
} from "../git/types.js";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Workspace git (KOBE-757, spec docs/specs/workspace-git.md §8). Team tables: every key and foreign
// key includes team_id; RLS in the custom migration after the generated one. The credential is
// stored only as KOBE-107 envelope text (`e1.<kid>...`, context kind `git-hosts`, the connection
// id as record id; `git/credential.ts`). No API returns it, it is never logged or audited, and it
// never reaches a sandbox, a browser or a model (G8).

const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
const n = (value: number) => sql.raw(String(value));
const re = (pattern: string) => sql.raw(`'${pattern}'`);

/**
 * A Workspace's connection to one organization on one git host (G1, G2). Up to
 * `GIT_CONNECTIONS_MAX` per Workspace (enforced by the routes); each (base URL, organization) once,
 * organization compared without case. Disconnecting deletes the row and with it the credential;
 * the Workspace's repository rows keep their record (`git_repositories.connection_id` is set to
 * null, G20).
 */
export const gitConnections = pgTable(
  "git_connections",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    provider: text().$type<GitProvider>().notNull(),
    /** Canonical https URL (`parseGitBaseUrl`): lowercase host, no trailing slash, no query. */
    baseUrl: text().notNull(),
    organization: text().notNull(),
    displayName: text().notNull(),
    credentialKind: text().$type<GitCredentialKind>().notNull(),
    /** KOBE-107 envelope text (`e1.` prefix); the plaintext never reaches Postgres. */
    credentialSealed: text().notNull(),
    /** KEK id of `credential_sealed` (`Envelope.keyIdOf`), so a rotation sweep finds stale rows. */
    credentialKeyId: text().notNull(),
    /** Masked hint of an access token (last characters only); null for a GitHub App. */
    credentialHint: text(),
    /** GitHub App ID and installation ID (G5): not secret, needed to mint installation tokens. */
    githubAppId: bigint({ mode: "number" }),
    githubInstallationId: bigint({ mode: "number" }),
    accessLevel: text().$type<GitAccessLevel>().notNull().default("read"),
    repoVisibility: text().$type<GitRepoVisibility>().notNull().default("private"),
    repoNamePrefix: text().notNull().default(""),
    defaultBranch: text().notNull().default("main"),
    pushLimitBytes: bigint({ mode: "number" }).notNull().default(GIT_PUSH_LIMIT_DEFAULT_BYTES),
    /** G18, GQ11: commits from Kobe's commit flow may go straight to the default branch. */
    directCommits: boolean().notNull().default(false),
    /** GQ8: the agents that may use the connection (no foreign key: team or personal agents). */
    agentIds: uuid().array(),
    /** What the credential may do (G4), from the last connection test. */
    capabilities: jsonb().$type<GitCapabilities>().notNull().default({}),
    lastCheckedAt: timestamp({ withTimezone: true }),
    lastOkAt: timestamp({ withTimezone: true }),
    /** Short machine code of the last failed check (never the host's message). */
    lastError: text(),
    /** Token expiry when the host reports one (G6); notices go out 14 days before. */
    credentialExpiresAt: timestamp({ withTimezone: true }),
    expiryNotifiedAt: timestamp({ withTimezone: true }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    credentialUpdatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("git_connections_org_unique").on(
      t.teamId,
      t.baseUrl,
      sql`lower(${t.organization})`,
    ),
    index("git_connections_created_by_idx").on(t.createdBy),
    index("git_connections_updated_by_idx").on(t.updatedBy),
    check("git_connections_provider", inList(t.provider, GIT_PROVIDER_VALUES)),
    check(
      "git_connections_base_url",
      sql`char_length(${t.baseUrl}) <= ${n(GIT_BASE_URL_MAX)} AND ${t.baseUrl} ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#[:space:]]*[^/?#[:space:]])?$'`,
    ),
    check(
      "git_connections_organization",
      sql`char_length(${t.organization}) <= ${n(GIT_ORGANIZATION_MAX)} AND ${t.organization} ~ ${re(GIT_ORGANIZATION_PATTERN)}`,
    ),
    check(
      "git_connections_display_name",
      sql`char_length(btrim(${t.displayName})) BETWEEN 1 AND ${n(GIT_DISPLAY_NAME_MAX)}`,
    ),
    check("git_connections_credential_kind", inList(t.credentialKind, GIT_CREDENTIAL_KIND_VALUES)),
    // G7: Gitea and Forgejo have no apps; a GitHub App names its app and installation.
    check(
      "git_connections_credential_shape",
      sql`(${t.credentialKind} = 'github_app' AND ${t.provider} = 'github' AND coalesce(${t.githubAppId}, 0) > 0 AND coalesce(${t.githubInstallationId}, 0) > 0 AND ${t.credentialHint} IS NULL)
        OR (${t.credentialKind} = 'access_token' AND ${t.githubAppId} IS NULL AND ${t.githubInstallationId} IS NULL)`,
    ),
    check(
      "git_connections_credential_sealed",
      sql`${t.credentialSealed} ~ '^e1\\.[A-Za-z0-9_.-]+$' AND char_length(${t.credentialSealed}) <= ${n(GIT_CREDENTIAL_SEALED_MAX)}`,
    ),
    check(
      "git_connections_credential_key_id",
      sql`char_length(${t.credentialKeyId}) BETWEEN 1 AND 64`,
    ),
    check(
      "git_connections_credential_hint",
      sql`${t.credentialHint} IS NULL OR char_length(${t.credentialHint}) <= ${n(GIT_CREDENTIAL_HINT_MAX)}`,
    ),
    check("git_connections_access_level", inList(t.accessLevel, GIT_ACCESS_LEVEL_VALUES)),
    check("git_connections_repo_visibility", inList(t.repoVisibility, GIT_REPO_VISIBILITY_VALUES)),
    check(
      "git_connections_repo_name_prefix",
      sql`char_length(${t.repoNamePrefix}) <= ${n(GIT_REPO_NAME_PREFIX_MAX)} AND ${t.repoNamePrefix} ~ ${re(GIT_REPO_NAME_PREFIX_PATTERN)}`,
    ),
    check(
      "git_connections_default_branch",
      sql`char_length(${t.defaultBranch}) <= ${n(GIT_BRANCH_NAME_MAX)} AND ${t.defaultBranch} ~ ${re(GIT_BRANCH_NAME_PATTERN)} AND ${t.defaultBranch} !~ '(\\.\\.|//|/$|\\.lock$|\\.$)'`,
    ),
    check(
      "git_connections_push_limit",
      sql`${t.pushLimitBytes} BETWEEN 1 AND ${n(GIT_PUSH_LIMIT_MAX_BYTES)}`,
    ),
    check(
      "git_connections_agent_ids",
      sql`${t.agentIds} IS NULL OR (array_ndims(${t.agentIds}) = 1 AND cardinality(${t.agentIds}) BETWEEN 1 AND ${n(GIT_CONNECTION_AGENTS_MAX)} AND array_position(${t.agentIds}, NULL) IS NULL)`,
    ),
    check("git_connections_capabilities", sql`jsonb_typeof(${t.capabilities}) = 'object'`),
    check(
      "git_connections_last_error",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= ${n(GIT_HEALTH_ERROR_MAX)}`,
    ),
  ],
);

/**
 * Repositories the Workspace works with on a connected host (§8): those agents created (G9), and
 * Repos (G15, `project_id` set, at most one row per project). The repository's content stays on the
 * host; the row holds its identity, the flags read from the host and the mirror state (G17).
 *
 * SQL-only keys (custom migration; drizzle cannot express `ON DELETE SET NULL (column)` on a key
 * that includes the NOT NULL team_id): (team_id, connection_id) -> git_connections and
 * (team_id, project_id) -> projects, both clearing only their own column, so a removed connection
 * or a deleted project leaves the repository's record (G20).
 */
export const gitRepositories = pgTable(
  "git_repositories",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid(),
    /** The host's own id (G20: followed through renames and transfers). */
    hostRepoId: text().notNull(),
    /** `organization/repository` as last seen on the host. */
    fullName: text().notNull(),
    defaultBranch: text().notNull().default("main"),
    projectId: uuid(),
    origin: text().$type<GitRepositoryOrigin>().notNull(),
    hostState: text().$type<GitRepositoryHostState>().notNull().default("active"),
    isPrivate: boolean().notNull().default(true),
    /** G14: null until the host was asked. */
    defaultBranchProtected: boolean(),
    /** G17: head commit of the mirrored default branch (SHA-1 or SHA-256 hex). */
    mirrorHeadSha: text(),
    mirrorRefreshedAt: timestamp({ withTimezone: true }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // One row per host repository per connection (nulls distinct: rows of removed connections).
    uniqueIndex("git_repositories_host_unique").on(t.teamId, t.connectionId, t.hostRepoId),
    // A project is at most one Repo (G15); also covers the project key.
    uniqueIndex("git_repositories_project_unique").on(t.teamId, t.projectId),
    index("git_repositories_created_by_idx").on(t.createdBy),
    check(
      "git_repositories_host_repo_id",
      sql`char_length(${t.hostRepoId}) BETWEEN 1 AND 64 AND ${t.hostRepoId} ~ '^[A-Za-z0-9_=-]+$'`,
    ),
    check(
      "git_repositories_full_name",
      sql`char_length(${t.fullName}) <= ${n(GIT_ORGANIZATION_MAX + 1 + GIT_REPOSITORY_NAME_MAX)} AND ${t.fullName} ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$'`,
    ),
    check(
      "git_repositories_default_branch",
      sql`char_length(${t.defaultBranch}) <= 255 AND char_length(${t.defaultBranch}) >= 1`,
    ),
    check("git_repositories_origin", inList(t.origin, GIT_REPOSITORY_ORIGIN_VALUES)),
    check("git_repositories_host_state", inList(t.hostState, GIT_REPOSITORY_HOST_STATE_VALUES)),
    check(
      "git_repositories_mirror_head",
      sql`${t.mirrorHeadSha} IS NULL OR ${t.mirrorHeadSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
  ],
);
