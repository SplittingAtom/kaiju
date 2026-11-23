import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  GIT_BRANCH_NAME_MAX,
  GIT_CONVERSION_STATUS_VALUES,
  GIT_CONVERSION_STEP_VALUES,
  GIT_ORGANIZATION_MAX,
  GIT_PROVIDER_VALUES,
  GIT_REPO_VISIBILITY_VALUES,
  type GitConversionStatus,
  type GitConversionStep,
  type GitProvider,
  type GitRepoVisibility,
} from "../git/types.js";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { teams } from "./teams.js";

const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
const n = (value: number) => sql.raw(String(value));

/** Longest code and detail a failed step stores (codes only; the detail names a file or commit). */
export const GIT_CONVERSION_ERROR_MAX = 64;
export const GIT_CONVERSION_ERROR_DETAIL_MAX = 1100;

/**
 * Convert to repo (KOBE-765, spec workspace-git G16): one attempt to turn a project into a Repo,
 * and the state of the resumable job that does it. The job never holds a transaction across a
 * call to the host: every step's outcome is written here in its own short transaction, so a
 * restarted server resumes at `step` (`lease_until` lapsed). The host's repository id is
 * recorded the moment the host answers the create (`host_repo_id`, with the `git_repositories`
 * row it links), so a retry adopts only the repository this attempt created. `plan` freezes the
 * commits to write (Kobe commit ids, authors, times, messages), so every attempt builds the same
 * git objects and the same hashes.
 *
 * SQL-only keys (custom migration): (team_id, connection_id) -> git_connections and
 * (team_id, repository_id) -> git_repositories, each clearing only its own column. Deleting the
 * project deletes its attempts (the repository row it created stays, G20).
 */
export const gitConversions = pgTable(
  "git_conversions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    projectId: uuid().notNull(),
    connectionId: uuid(),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** The connection as it was asked for (labels and the host check survive a disconnect). */
    provider: text().$type<GitProvider>().notNull(),
    baseUrl: text().notNull(),
    organization: text().notNull(),
    repositoryName: text().notNull(),
    visibility: text().$type<GitRepoVisibility>().notNull(),
    /** GQ12: the project's commits as git commits (true), or one commit of the current files. */
    carryHistory: boolean().notNull(),
    /** G16: push into an existing, empty repository the requester chose instead of creating one. */
    useExisting: boolean().notNull().default(false),
    defaultBranch: text().notNull(),
    status: text().$type<GitConversionStatus>().notNull().default("running"),
    step: text().$type<GitConversionStep>().notNull().default("create"),
    /** Set before the create call: an unrecorded answer is looked for on the next attempt. */
    createAttemptedAt: timestamp({ withTimezone: true }),
    hostRepoId: text(),
    repositoryId: uuid(),
    /** The frozen commit plan (`conversion/plan.ts`); null until the job wrote it. */
    plan: jsonb(),
    commitsTotal: integer(),
    commitsPushed: integer().notNull().default(0),
    /** The git commit the default branch must point at when the push is done. */
    headSha: text(),
    lastError: text(),
    lastErrorDetail: text(),
    attempts: integer().notNull().default(0),
    /** The replica working on it and until when (renewed while it works). */
    leaseOwner: text(),
    leaseUntil: timestamp({ withTimezone: true }),
    /** When a replica last claimed it, and when a run last moved it forward (a step, a batch). */
    claimedAt: timestamp({ withTimezone: true }),
    progressAt: timestamp({ withTimezone: true }),
    /**
     * Automatic resumes since a person last started or retried it, and how many claims in a row
     * ended with the replica gone and no progress (the poison guard: the sweep fails the attempt
     * instead of claiming it again, so one conversion cannot take down replica after replica).
     */
    resumes: integer().notNull().default(0),
    stalls: integer().notNull().default(0),
    finishedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "git_conversions_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    // One attempt holds a project at a time (running or failed); finished ones are history.
    uniqueIndex("git_conversions_active_unique")
      .on(t.teamId, t.projectId)
      .where(sql`${t.status} IN ('running', 'failed')`),
    index("git_conversions_project_idx").on(t.teamId, t.projectId, t.createdAt),
    // The resume sweep looks for running attempts whose lease lapsed.
    index("git_conversions_running_idx")
      .on(t.teamId, t.leaseUntil)
      .where(sql`${t.status} = 'running'`),
    index("git_conversions_connection_idx").on(t.teamId, t.connectionId),
    index("git_conversions_repository_idx").on(t.teamId, t.repositoryId),
    index("git_conversions_requested_by_idx").on(t.requestedBy),
    index("git_conversions_finished_by_idx").on(t.finishedBy),
    check("git_conversions_provider", inList(t.provider, GIT_PROVIDER_VALUES)),
    check(
      "git_conversions_base_url",
      sql`${t.baseUrl} ~ '^https://' AND char_length(${t.baseUrl}) <= 2048`,
    ),
    check(
      "git_conversions_organization",
      sql`char_length(${t.organization}) BETWEEN 1 AND ${n(GIT_ORGANIZATION_MAX)}`,
    ),
    check(
      "git_conversions_repository_name",
      sql`${t.repositoryName} ~ '^[A-Za-z0-9._-]{1,100}$' AND ${t.repositoryName} NOT IN ('.', '..') AND ${t.repositoryName} !~ '\\.git$'`,
    ),
    check("git_conversions_visibility", inList(t.visibility, GIT_REPO_VISIBILITY_VALUES)),
    check(
      "git_conversions_default_branch",
      sql`char_length(${t.defaultBranch}) BETWEEN 1 AND ${n(GIT_BRANCH_NAME_MAX)}`,
    ),
    check("git_conversions_status", inList(t.status, GIT_CONVERSION_STATUS_VALUES)),
    check("git_conversions_step", inList(t.step, GIT_CONVERSION_STEP_VALUES)),
    check(
      "git_conversions_host_repo_id",
      sql`${t.hostRepoId} IS NULL OR (char_length(${t.hostRepoId}) BETWEEN 1 AND 64 AND ${t.hostRepoId} ~ '^[A-Za-z0-9_=-]+$')`,
    ),
    check(
      "git_conversions_head_sha",
      sql`${t.headSha} IS NULL OR ${t.headSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      "git_conversions_counts",
      sql`${t.attempts} >= 0 AND ${t.resumes} >= 0 AND ${t.stalls} >= 0 AND ${t.commitsPushed} >= 0 AND (${t.commitsTotal} IS NULL OR ${t.commitsPushed} <= ${t.commitsTotal})`,
    ),
    check(
      "git_conversions_error",
      sql`(${t.lastError} IS NULL OR ${t.lastError} ~ '^[a-z0-9_]{1,${n(GIT_CONVERSION_ERROR_MAX)}}$') AND (${t.lastErrorDetail} IS NULL OR char_length(${t.lastErrorDetail}) <= ${n(GIT_CONVERSION_ERROR_DETAIL_MAX)})`,
    ),
    check("git_conversions_plan", sql`${t.plan} IS NULL OR jsonb_typeof(${t.plan}) = 'object'`),
    // A finished attempt has its time; a completed one points at its repository.
    check(
      "git_conversions_finished",
      sql`(${t.status} IN ('completed', 'abandoned')) = (${t.finishedAt} IS NOT NULL)
        AND (${t.status} <> 'completed' OR (${t.step} = 'done' AND ${t.hostRepoId} IS NOT NULL))`,
    ),
  ],
);
