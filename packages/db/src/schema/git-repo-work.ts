import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { gitRepositories } from "./git.js";
import { projects } from "./projects.js";
import { teams } from "./teams.js";

const SHA = "'^([0-9a-f]{40}|[0-9a-f]{64})$'";
/** A branch name as git and the hosts take it (`refs/heads/<name>`), at most 255 characters. */
const BRANCH = "'^[^[:space:]:~^?*\\[\\\\]{1,255}$'";

/**
 * Committing to a Repo from Kobe's commit flow (KOBE-767, spec workspace-git G18, GQ11): the
 * member's pull request from their working copy of a Repo. One row per member and Repo: the
 * first commit pushes a branch of its own and opens a pull request; later commits from the same
 * working copy (same base) add to that branch while the pull request is open; a commit after the
 * base moved, or after the pull request was closed or merged, starts a new branch and replaces
 * the row (the audit log keeps each one). `head_sha` is what Kobe last pushed: the next push is a
 * compare-and-swap from it, so a branch someone else moved on the host is never overwritten.
 */
export const gitCommitBranches = pgTable(
  "git_commit_branches",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid().notNull(),
    /** The Kobe commit the member's checkout was based on when the branch started. */
    baseCommitId: uuid().notNull(),
    /** The default branch's commit on the host the branch starts from (Kobe's mirror head then). */
    baseSha: text().notNull(),
    branch: text().notNull(),
    headSha: text().notNull(),
    /** The tree of `head_sha`: a commit whose tree is the same is "nothing to commit". */
    treeSha: text().notNull(),
    pullNumber: integer().notNull(),
    pullUrl: text().notNull().default(""),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.projectId, t.userId] }),
    foreignKey({
      name: "git_commit_branches_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "git_commit_branches_repository_fk",
      columns: [t.teamId, t.repositoryId],
      foreignColumns: [gitRepositories.teamId, gitRepositories.id],
    }).onDelete("cascade"),
    index("git_commit_branches_user_idx").on(t.userId),
    index("git_commit_branches_repository_idx").on(t.teamId, t.repositoryId),
    check(
      "git_commit_branches_shas",
      sql`${t.baseSha} ~ ${sql.raw(SHA)} AND ${t.headSha} ~ ${sql.raw(SHA)} AND ${t.treeSha} ~ ${sql.raw(SHA)}`,
    ),
    check(
      "git_commit_branches_branch",
      sql`${t.branch} ~ ${sql.raw(BRANCH)} AND ${t.branch} NOT LIKE '%..%'`,
    ),
    check("git_commit_branches_pull", sql`${t.pullNumber} > 0`),
    check(
      "git_commit_branches_pull_url",
      sql`${t.pullUrl} = '' OR (${t.pullUrl} ~ '^https?://' AND char_length(${t.pullUrl}) <= 2048)`,
    ),
  ],
);

/**
 * The state of a member's git working copy of a Repo in their sandbox (KOBE-767, G19), as the
 * sandbox agent last reported it after preparing or fetching it at run start and when the run
 * ended: branch, head, what it tracks, commits ahead of and behind the host, uncommitted changes.
 * One row per member and Repo, replaced by each report. No file names and no content.
 */
export const gitWorkingCopies = pgTable(
  "git_working_copies",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null: detached HEAD. */
    branch: text(),
    /** Null: no commit yet (an empty repository). */
    headSha: text(),
    /** What ahead/behind count against (`origin/<branch>`, or `origin/<default>`); null: nothing. */
    upstream: text(),
    ahead: integer().notNull().default(0),
    behind: integer().notNull().default(0),
    dirty: boolean().notNull().default(false),
    /** False when the last fetch failed: `behind` may be stale. */
    fetched: boolean().notNull().default(true),
    /** The agent's short reason when preparing or fetching failed. */
    problem: text(),
    /** The run that reported it (no key: runs are compacted and deleted on their own). */
    runId: uuid(),
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.projectId, t.userId] }),
    foreignKey({
      name: "git_working_copies_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    index("git_working_copies_user_idx").on(t.userId),
    check(
      "git_working_copies_branch",
      sql`(${t.branch} IS NULL OR ${t.branch} ~ ${sql.raw(BRANCH)}) AND (${t.upstream} IS NULL OR ${t.upstream} ~ ${sql.raw(BRANCH)})`,
    ),
    check("git_working_copies_head", sql`${t.headSha} IS NULL OR ${t.headSha} ~ ${sql.raw(SHA)}`),
    check(
      "git_working_copies_counts",
      sql`${t.ahead} BETWEEN 0 AND 10000 AND ${t.behind} BETWEEN 0 AND 10000`,
    ),
    check(
      "git_working_copies_problem",
      sql`${t.problem} IS NULL OR char_length(${t.problem}) <= 200`,
    ),
  ],
);
