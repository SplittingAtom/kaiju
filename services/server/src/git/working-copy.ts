import { readGitConnection, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  runGitRepoSchema,
  type RepoStatusFrame,
  type RunGitContext,
  type RunGitRepo,
} from "@kobe/protocol/sandbox-wire";
import { loadAccess } from "../projects/access.js";
import { reachableBase } from "./transport.js";

/**
 * A conversation's Repo as a git working copy in the member's sandbox (KOBE-767, spec
 * workspace-git G18, G19).
 *
 * - {@link runGitRepo}: `run.start.git.repo` for a run on a thread in a Repo: where the agent keeps
 *   the working copy (`repos/<slug>`), the repository's ordinary https clone URL (the tools' git
 *   config routes it through the egress proxy, which adds the credential, KOBE-763/764) and the
 *   default branch. Only while the thread's owner may converse in the project, the repository is
 *   active and its connection is one the sandbox's git may use (among `remotes`). No credential.
 * - {@link recordRepoStatus}: the agent's report of the working copy (branch, head, ahead/behind,
 *   uncommitted changes), kept per member and Repo for the Files panel (G19). Accepted only for a
 *   run of the reporting member on a thread in that Repo.
 * - {@link readWorkingCopy}: the member's own last report, for the project routes.
 */

export async function runGitRepo(
  db: KobeDb,
  target: { readonly teamId: string; readonly userId: string },
  threadId: string,
  context: RunGitContext,
): Promise<RunGitRepo | undefined> {
  const { teamId, userId } = target;
  return withTeam(db, teamId, async (tx) => {
    const threads = await tx.execute<{ project_id: string | null }>(sql`
      SELECT project_id FROM threads
       WHERE team_id = ${teamId} AND id = ${threadId} AND owner_user_id = ${userId}`);
    const projectId = threads.rows[0]?.project_id ?? null;
    if (projectId === null) return undefined;
    const access = await loadAccess(tx, target, projectId);
    if (!access?.can.converse || access.project.kind !== "repo") return undefined;
    const repo = await repoOf(tx, teamId, projectId);
    if (!repo || repo.host_state !== "active" || repo.connection_id === null) return undefined;
    const connection = await readGitConnection(tx, teamId, repo.connection_id);
    if (!connection || connection.accessLevel === "off" || connection.agentIds !== null) {
      return undefined;
    }
    const base = reachableBase(connection.baseUrl);
    if (base === undefined) return undefined;
    const baseUrl = `https://${base.host}${base.path}`;
    const [org, name] = repo.full_name.split("/");
    if (org === undefined || name === undefined) return undefined;
    // The sandbox's git reaches only connected organizations it was told about (G11).
    const listed = context.remotes.some(
      (r) => r.base_url === baseUrl && r.organization.toLowerCase() === org.toLowerCase(),
    );
    if (!listed || org.toLowerCase() !== connection.organization.toLowerCase()) return undefined;
    const roles = await tx.execute<{ role: string }>(sql`
      SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`);
    const write =
      access.can.edit &&
      roles.rows[0]?.role !== "member" &&
      connection.accessLevel === "read_write";
    const parsed = runGitRepoSchema.safeParse({
      project_id: projectId,
      slug: access.project.slug,
      // The connection's spelling of the organization: the tools' rewrite is case-sensitive.
      clone_url: `${baseUrl}/${connection.organization}/${name}.git`,
      default_branch: repo.default_branch,
      access: write ? "write" : "read",
    });
    return parsed.success ? parsed.data : undefined;
  });
}

async function repoOf(tx: KobeTx, teamId: string, projectId: string) {
  const res = await tx.execute<{
    id: string;
    connection_id: string | null;
    full_name: string;
    default_branch: string;
    host_state: string;
  }>(sql`
    SELECT id, connection_id, full_name, default_branch, host_state FROM git_repositories
     WHERE team_id = ${teamId} AND project_id = ${projectId}`);
  return res.rows[0];
}

/**
 * Stores a `repo.status` report; false when it does not belong to the member (another member's
 * thread, a thread outside that Repo, a project that is not a Repo), so the caller drops it.
 */
export async function recordRepoStatus(
  db: KobeDb,
  target: { readonly teamId: string; readonly userId: string },
  frame: RepoStatusFrame,
): Promise<boolean> {
  const { teamId, userId } = target;
  return withTeam(db, teamId, async (tx) => {
    const ok = await tx.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        JOIN projects p ON p.team_id = t.team_id AND p.id = t.project_id
       WHERE r.team_id = ${teamId} AND r.id = ${frame.run_id} AND r.thread_id = ${frame.thread_id}
         AND t.team_id = ${teamId} AND t.owner_user_id = ${userId}
         AND t.project_id = ${frame.project_id} AND p.kind = 'repo'`);
    if (ok.rows.length === 0) return false;
    await tx.execute(sql`
      INSERT INTO git_working_copies
        (team_id, project_id, user_id, branch, head_sha, upstream, ahead, behind, dirty, fetched,
         problem, run_id, reported_at)
      VALUES (${teamId}, ${frame.project_id}, ${userId}, ${frame.branch}, ${frame.head_sha},
              ${frame.upstream}, ${frame.ahead}, ${frame.behind}, ${frame.dirty}, ${frame.fetched},
              ${frame.problem}, ${frame.run_id}, now())
      ON CONFLICT (team_id, project_id, user_id) DO UPDATE SET
        branch = EXCLUDED.branch, head_sha = EXCLUDED.head_sha, upstream = EXCLUDED.upstream,
        ahead = EXCLUDED.ahead, behind = EXCLUDED.behind, dirty = EXCLUDED.dirty,
        fetched = EXCLUDED.fetched, problem = EXCLUDED.problem, run_id = EXCLUDED.run_id,
        reported_at = now()`);
    return true;
  });
}

export interface WorkingCopyView {
  readonly branch: string | null;
  readonly head_sha: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  readonly fetched: boolean;
  readonly problem: string | null;
  readonly reported_at: string;
}

/** The member's own last report for a Repo, or null when their sandbox never reported one. */
export async function readWorkingCopy(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  userId: string,
): Promise<WorkingCopyView | null> {
  const res = await tx.execute<{
    branch: string | null;
    head_sha: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    dirty: boolean;
    fetched: boolean;
    problem: string | null;
    reported_at: Date | string;
  }>(sql`
    SELECT branch, head_sha, upstream, ahead, behind, dirty, fetched, problem, reported_at
      FROM git_working_copies
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND user_id = ${userId}`);
  const r = res.rows[0];
  if (!r) return null;
  return { ...r, reported_at: new Date(r.reported_at).toISOString() };
}
