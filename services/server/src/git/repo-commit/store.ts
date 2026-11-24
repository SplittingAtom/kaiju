import {
  readGitConnection,
  readGitConnectionSealedCredential,
  sql,
  type GitConnectionRecord,
  type GitSealedCredentialRow,
  type KaijuTx,
  type TeamRole,
} from "@kaiju/db";

/**
 * What a commit to a Repo reads and writes in the database (KOBE-767): the Repo's repository row
 * and connection, the member, and the member's open pull request (`git_commit_branches`). Always
 * inside `withTeam()` (team tables under RLS), with `team_id` stated in every query.
 */

export interface RepoRow {
  readonly id: string;
  readonly connectionId: string | null;
  readonly baseUrl: string;
  readonly hostRepoId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly hostState: string;
  readonly mirrorHeadSha: string | null;
  /** The Kaiju commit that is the copy of `mirrorHeadSha` (set by conversion, mirror, direct commits). */
  readonly mirrorCommitId: string | null;
}

export interface BranchRow {
  readonly repositoryId: string;
  readonly baseCommitId: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly pullNumber: number;
  readonly pullUrl: string;
}

export interface RepoCommitFacts {
  readonly repo: RepoRow;
  readonly connection: GitConnectionRecord | undefined;
  readonly sealed: GitSealedCredentialRow | undefined;
  readonly role: TeamRole | null;
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly teamSettings: unknown;
  readonly branch: BranchRow | undefined;
  /** For an agent's commit: the run's agent (null: a run without an agent). */
  readonly runAgentId?: string | null;
}

/**
 * Read in the same transaction as the commit's plan (review H1), with the repository row locked
 * `FOR SHARE`, so the mirror head and Kaiju's head are one consistent snapshot.
 */
export async function loadRepoCommitFacts(
  tx: KaijuTx,
  teamId: string,
  userId: string,
  projectId: string,
  runId?: string,
): Promise<RepoCommitFacts | undefined> {
  const repos = await tx.execute<{
    id: string;
    connection_id: string | null;
    base_url: string;
    host_repo_id: string;
    full_name: string;
    default_branch: string;
    host_state: string;
    mirror_head_sha: string | null;
    mirror_commit_id: string | null;
  }>(sql`
    SELECT id, connection_id, base_url, host_repo_id, full_name, default_branch, host_state,
           mirror_head_sha, mirror_commit_id
      FROM git_repositories
     WHERE team_id = ${teamId} AND project_id = ${projectId}
       FOR SHARE`);
  const r = repos.rows[0];
  if (!r) return undefined;
  const people = await tx.execute<{
    id: string;
    name: string | null;
    email: string;
    role: TeamRole | null;
    settings: unknown;
  }>(sql`
    SELECT u.id, u.name, u.email, tm.role, t.settings
      FROM public.users u
      JOIN teams t ON t.id = ${teamId}
      LEFT JOIN team_members tm ON tm.team_id = ${teamId} AND tm.user_id = u.id
     WHERE u.id = ${userId}`);
  const p = people.rows[0];
  if (!p) return undefined;
  const branches = await tx.execute<{
    repository_id: string;
    base_commit_id: string;
    base_sha: string;
    branch: string;
    head_sha: string;
    tree_sha: string;
    pull_number: number;
    pull_url: string;
  }>(sql`
    SELECT repository_id, base_commit_id, base_sha, branch, head_sha, tree_sha, pull_number,
           pull_url
      FROM git_commit_branches
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND user_id = ${userId}`);
  const b = branches.rows[0];
  const connectionId = r.connection_id;
  let runAgentId: string | null | undefined;
  if (runId !== undefined) {
    const runs = await tx.execute<{ agent_id: string | null }>(sql`
      SELECT t.agent_id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND r.id = ${runId} AND t.team_id = ${teamId}`);
    runAgentId = runs.rows[0]?.agent_id ?? null;
  }
  return {
    repo: {
      id: r.id,
      connectionId,
      baseUrl: r.base_url,
      hostRepoId: r.host_repo_id,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      hostState: r.host_state,
      mirrorHeadSha: r.mirror_head_sha,
      mirrorCommitId: r.mirror_commit_id,
    },
    connection:
      connectionId === null ? undefined : await readGitConnection(tx, teamId, connectionId),
    sealed:
      connectionId === null
        ? undefined
        : await readGitConnectionSealedCredential(tx, teamId, connectionId),
    role: p.role,
    user: { id: p.id, name: p.name ?? "", email: p.email },
    teamSettings: p.settings,
    ...(runAgentId === undefined ? {} : { runAgentId }),
    branch: b
      ? {
          repositoryId: b.repository_id,
          baseCommitId: b.base_commit_id,
          baseSha: b.base_sha,
          branch: b.branch,
          headSha: b.head_sha,
          treeSha: b.tree_sha,
          pullNumber: b.pull_number,
          pullUrl: b.pull_url,
        }
      : undefined,
  };
}

/** Records (or replaces) the member's pull request branch of a Repo. */
export async function saveBranch(
  tx: KaijuTx,
  key: { readonly teamId: string; readonly projectId: string; readonly userId: string },
  row: BranchRow,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO git_commit_branches
      (team_id, project_id, user_id, repository_id, base_commit_id, base_sha, branch, head_sha,
       tree_sha, pull_number, pull_url)
    VALUES (${key.teamId}, ${key.projectId}, ${key.userId}, ${row.repositoryId},
            ${row.baseCommitId}, ${row.baseSha}, ${row.branch}, ${row.headSha}, ${row.treeSha},
            ${row.pullNumber}, ${row.pullUrl})
    ON CONFLICT (team_id, project_id, user_id) DO UPDATE SET
      repository_id = EXCLUDED.repository_id, base_commit_id = EXCLUDED.base_commit_id,
      base_sha = EXCLUDED.base_sha, branch = EXCLUDED.branch, head_sha = EXCLUDED.head_sha,
      tree_sha = EXCLUDED.tree_sha, pull_number = EXCLUDED.pull_number,
      pull_url = EXCLUDED.pull_url, updated_at = now()`);
}
