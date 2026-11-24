import { sql, type KaijuTx } from "@kaiju/db";
import { gitIdentitySchema } from "@kaiju/protocol/sandbox-wire";
import { z } from "zod";
import {
  GIT_COMMITTER_SUFFIX,
  buildRunGitContext,
  gitAuthorName,
  gitCommitEmailMode,
  gitNoReplyEmail,
  type GitCommitEmailMode,
} from "../sandbox-git.js";

/**
 * The commit plan of a conversion (KOBE-765, G16): which git commits to write, frozen when the job
 * starts so every attempt builds the same objects and the same hashes. Each entry names the Kaiju
 * commit whose tree it carries (null: an empty tree) and its author, committer, time and message.
 *
 * With history (GQ12, the default) every remaining Kaiju commit becomes one git commit, oldest
 * first, with the member who made it as author (an agent's commit names the member whose
 * conversation it was, as Kaiju records it), "<name> via Kaiju" as committer (G13), the commit's
 * own time for both, and its message. Without history, one commit carries the current files,
 * authored by the member who converts at the time they asked.
 *
 * Emails follow the Workspace's commit email setting (GQ10, KOBE-764: the member's Kaiju email, or
 * the no-reply form). A member who left (no longer in the Workspace, or deactivated) keeps their
 * name with the no-reply form of the address whatever the setting, never their mailbox (review
 * L1: the owner's privacy default); a member Kaiju no longer knows becomes "Former member".
 */
export interface PlanIdentity {
  readonly name: string;
  readonly email: string;
}

export interface PlanCommit {
  /** The Kaiju commit whose tree this carries; null for an empty tree (a project without commits). */
  readonly kobeCommitId: string | null;
  /** Its number in Kaiju; null for the single commit without history. */
  readonly seq: number | null;
  readonly message: string;
  /** Seconds since the epoch (UTC), author and committer alike. */
  readonly time: number;
  readonly author: PlanIdentity;
  readonly committer: PlanIdentity;
}

export interface ConversionPlan {
  readonly v: 1;
  readonly branch: string;
  readonly history: boolean;
  /** The project's head when the plan was made: the finish checks it did not move. */
  readonly headCommitId: string | null;
  readonly commits: readonly PlanCommit[];
}

const identity = z.strictObject({ name: z.string().min(1).max(256), email: z.string().min(3) });
export const conversionPlanSchema = z.strictObject({
  v: z.literal(1),
  branch: z.string().min(1).max(255),
  history: z.boolean(),
  headCommitId: z.uuid().nullable(),
  commits: z
    .array(
      z.strictObject({
        kobeCommitId: z.uuid().nullable(),
        seq: z.number().int().positive().nullable(),
        message: z.string().min(1).max(4000),
        time: z.number().int().nonnegative(),
        author: identity,
        committer: identity,
      }),
    )
    .min(1),
});

export const FORMER_MEMBER = "Former member";

export interface PlanUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** No longer in the Workspace, or deactivated. */
  readonly left: boolean;
}

/** The author and committer of a member's commits (pure). */
export function conversionIdentity(
  user: PlanUser | undefined,
  userId: string,
  mode: GitCommitEmailMode,
  siteHost: string,
): { author: PlanIdentity; committer: PlanIdentity } {
  if (user === undefined || user.left) {
    const name = user === undefined ? FORMER_MEMBER : user.name;
    const clean = gitAuthorName(name, 200 - GIT_COMMITTER_SUFFIX.length);
    const email = gitNoReplyEmail({ id: userId, name: clean }, siteHost);
    const parsed = gitIdentitySchema.shape.email.safeParse(email);
    const safe = parsed.success ? email : `${userId.slice(0, 8)}@users.noreply.invalid`;
    return {
      author: { name: clean, email: safe },
      committer: { name: `${clean}${GIT_COMMITTER_SUFFIX}`, email: safe },
    };
  }
  const ctx = buildRunGitContext({ user, mode, siteHost, connections: [] });
  return { author: ctx.author, committer: ctx.committer };
}

/** A Kaiju message as a git message: trimmed, one trailing newline. */
export function gitMessage(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  return `${trimmed === "" ? "Update" : trimmed}\n`;
}

type CommitRow = {
  id: string;
  seq: number;
  author_user_id: string;
  message: string;
  created_at: Date | string;
};

const epoch = (at: Date | string) => Math.floor(new Date(at).getTime() / 1000);

/** Reads the project and its authors and freezes the plan (in the caller's team transaction). */
export async function buildConversionPlan(
  tx: KaijuTx,
  input: {
    readonly teamId: string;
    readonly projectId: string;
    readonly carryHistory: boolean;
    readonly branch: string;
    readonly requestedBy: string;
    readonly requestedAt: Date;
    readonly siteHost: string;
  },
): Promise<ConversionPlan> {
  const { teamId, projectId } = input;
  const project = await tx.execute<{
    name: string;
    head_commit_id: string | null;
    settings: unknown;
  }>(sql`
    SELECT p.name, p.head_commit_id, t.settings FROM projects p JOIN teams t ON t.id = p.team_id
     WHERE p.team_id = ${teamId} AND p.id = ${projectId}`);
  const row = project.rows[0];
  if (!row) throw new Error("conversion plan: the project is gone");
  const mode = gitCommitEmailMode(row.settings);
  const head = row.head_commit_id;
  const commits = input.carryHistory
    ? (
        await tx.execute<CommitRow>(sql`
          SELECT id, seq, author_user_id, message, created_at FROM project_commits
           WHERE team_id = ${teamId} AND project_id = ${projectId} ORDER BY seq`)
      ).rows
    : [];
  const userIds = [...new Set([input.requestedBy, ...commits.map((c) => c.author_user_id)])];
  const users = await tx.execute<{ id: string; name: string; email: string; left: boolean }>(sql`
    SELECT u.id, u.name, u.email,
           (u.deactivated_at IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM team_members tm WHERE tm.team_id = ${teamId} AND tm.user_id = u.id))
             AS left
      FROM users u WHERE u.id IN ${userIds}`);
  const byId = new Map(
    users.rows.map((u) => [u.id, { id: u.id, name: u.name, email: u.email, left: u.left }]),
  );
  const who = (id: string) => conversionIdentity(byId.get(id), id, mode, input.siteHost);
  if (commits.length > 0) {
    return {
      v: 1,
      branch: input.branch,
      history: true,
      headCommitId: head,
      commits: commits.map((c) => ({
        kobeCommitId: c.id,
        seq: Number(c.seq),
        message: gitMessage(c.message),
        time: epoch(c.created_at),
        ...who(c.author_user_id),
      })),
    };
  }
  const seq = head
    ? (
        await tx.execute<{ seq: number }>(sql`
          SELECT seq FROM project_commits WHERE team_id = ${teamId} AND id = ${head}`)
      ).rows[0]?.seq
    : undefined;
  const title = `${row.name.trim() || "Project"}: files from Kaiju`;
  const body =
    seq === undefined
      ? "The project had no files yet when it was converted to a Repo."
      : `The project's files at Kaiju commit #${Number(seq)}, when it was converted to a Repo.`;
  return {
    v: 1,
    branch: input.branch,
    history: false,
    headCommitId: head,
    commits: [
      {
        kobeCommitId: head,
        seq: null,
        message: `${title}\n\n${body}\n`,
        time: epoch(input.requestedAt),
        ...who(input.requestedBy),
      },
    ],
  };
}

/** Reads a stored plan back (refuses anything that is not a plan this code wrote). */
export function parsePlan(value: unknown): ConversionPlan {
  return conversionPlanSchema.parse(value);
}
