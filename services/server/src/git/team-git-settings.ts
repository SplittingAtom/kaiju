import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { GitCommitEmailMode } from "@kobe/protocol";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import {
  GIT_COMMIT_EMAIL_MODES,
  TEAM_GIT_COMMIT_EMAIL_SETTING,
  gitCommitEmailMode,
} from "./sandbox-git.js";

/**
 * The Workspace's git settings (KOBE-761; `/v1/team/git/settings`, `team.git.manage`): today the
 * author email of commits made in sandboxes (G13, GQ10), stored in
 * `teams.settings.git_commit_email` and read at each run start by KOBE-764's
 * `gitCommitEmailMode()`. A change is audited once, with the old and new value.
 */
export const gitTeamSettingsBodySchema = z.strictObject({
  commit_email: z.enum(GIT_COMMIT_EMAIL_MODES),
});
export type GitTeamSettingsBody = z.infer<typeof gitTeamSettingsBodySchema>;

export async function readGitCommitEmail(db: KobeDb, teamId: string): Promise<GitCommitEmailMode> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ settings: unknown }>(
      sql`SELECT settings FROM teams WHERE id = ${teamId}`,
    );
    return gitCommitEmailMode(res.rows[0]?.settings);
  });
}

/** Stores the choice (team row locked, so two saves don't interleave); audits a real change. */
export async function writeGitCommitEmail(
  db: KobeDb,
  teamId: string,
  mode: GitCommitEmailMode,
): Promise<GitCommitEmailMode> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ settings: unknown }>(
      sql`SELECT settings FROM teams WHERE id = ${teamId} FOR NO KEY UPDATE`,
    );
    const previous = gitCommitEmailMode(res.rows[0]?.settings);
    if (previous === mode) return mode;
    await tx.execute(sql`
      UPDATE teams
         SET settings = jsonb_set(
               CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
               ${`{${TEAM_GIT_COMMIT_EMAIL_SETTING}}`}::text[], ${JSON.stringify(mode)}::jsonb)
       WHERE id = ${teamId}`);
    await recordAudit(tx, {
      action: "git.settings.updated",
      teamId,
      target: { setting: "commit_email", value: mode, previous },
    });
    return mode;
  });
}
