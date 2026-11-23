import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { GIT_MIRROR_AUTHOR_MAX, GIT_MIRROR_LOG_MAX, GIT_MIRROR_MESSAGE_MAX } from "../git/types.js";
import { gitRepositories } from "./git.js";
import { teams } from "./teams.js";

const n = (value: number) => sql.raw(String(value));

/**
 * The Repo mirror's commit list (KOBE-766, spec workspace-git G17): the newest commits of the
 * host's default branch as the last refresh saw them, `position` 0 the head. Replaced whole by
 * each refresh that found a new head; kept as it was when the host goes away (G20: the Repo stays
 * readable from its last mirror). Author name and subject are untrusted host text (shown as plain
 * text, never to a model as instructions); no email address is kept. Team table: RLS in the
 * custom migration after the generated one; rows go with their repository row.
 */
export const gitRepositoryCommits = pgTable(
  "git_repository_commits",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    repositoryId: uuid().notNull(),
    position: smallint().notNull(),
    sha: text().notNull(),
    authorName: text().notNull(),
    authoredAt: timestamp({ withTimezone: true }).notNull(),
    message: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.repositoryId, t.position] }),
    foreignKey({
      name: "git_repository_commits_repository_fk",
      columns: [t.teamId, t.repositoryId],
      foreignColumns: [gitRepositories.teamId, gitRepositories.id],
    }).onDelete("cascade"),
    check(
      "git_repository_commits_position",
      sql`${t.position} >= 0 AND ${t.position} < ${n(GIT_MIRROR_LOG_MAX)}`,
    ),
    check("git_repository_commits_sha", sql`${t.sha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check(
      "git_repository_commits_author",
      sql`char_length(${t.authorName}) <= ${n(GIT_MIRROR_AUTHOR_MAX)}`,
    ),
    check(
      "git_repository_commits_message",
      sql`char_length(${t.message}) <= ${n(GIT_MIRROR_MESSAGE_MAX)}`,
    ),
  ],
);
