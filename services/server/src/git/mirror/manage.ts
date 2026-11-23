import { sql, withTeam, type KobeTx } from "@kobe/db";
import type { GitRepoDetached, GitRepoRelinkBody, GitRepoView } from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { GitHostError, type GitRepository } from "../../git-hosts/adapter.js";
import { loadAccess, teamRoleFor } from "../../projects/access.js";
import { headOf, loadTree, writeCommit } from "../../projects/tree.js";
import { checkRateLimit } from "../../rate-limit.js";
import type { RateLimitRule } from "../../rate-limit.js";
import { kickMirrorRefresh } from "./job.js";
import {
  GIT_MIRROR_MANAGE_RATE,
  GIT_MIRROR_OPEN_STALE_MS,
  GIT_MIRROR_REFRESH_RATE,
} from "./limits.js";
import { MirrorStop, openConnection, type MirrorDeps } from "./refresh.js";
import { failureView, MIRROR_FAILURE_MESSAGES, readOnlyReason, revokeLease } from "./store.js";

/**
 * The Repo routes' work (KOBE-766, G17, G20): reading a Repo (any member who views the project:
 * Repo reads are for project members only), Refresh, and a Workspace admin's relink and detach.
 * Reads never wait for the host: opening a Repo whose mirror is older than a minute starts a
 * refresh in the background and answers with the mirror as it is.
 */
export type Viewer = { readonly teamId: string; readonly userId: string };

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

const plain = (status: number, code: string, message: string): Outcome<never> => ({
  ok: false,
  status,
  body: { code, message },
});
const NOT_FOUND = plain(404, "not_found", "No project with that id is available to you.");
const NOT_A_REPO = plain(404, "not_a_repo", "This project is not a Repo.");
const ADMINS_ONLY = plain(
  403,
  "forbidden",
  "Only Workspace admins may relink a Repo or turn it back into a project.",
);

async function limited(
  deps: Pick<MirrorDeps, "db">,
  key: string,
  rule: RateLimitRule,
  message: string,
): Promise<Outcome<never> | undefined> {
  const verdict = await checkRateLimit(deps.db, key, rule);
  if (verdict.allowed) return undefined;
  return {
    ok: false,
    status: 429,
    body: { code: "rate_limited", message, retry_after_seconds: verdict.retryAfterSeconds },
  };
}

type RepoRow = {
  id: string;
  connection_id: string | null;
  provider: "github" | "gitea" | "forgejo" | null;
  base_url: string;
  full_name: string;
  default_branch: string;
  host_state: "active" | "archived" | "deleted" | "unreachable";
  mirror_head_sha: string | null;
  mirror_commit_id: string | null;
  mirror_refreshed_at: Date | string | null;
  mirror_attempted_at: Date | string | null;
  mirror_next_at: Date | string | null;
  mirror_failures: number;
  mirror_error: string | null;
  refreshing: boolean;
};

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

async function repoOf(tx: KobeTx, teamId: string, projectId: string): Promise<RepoRow | undefined> {
  const res = await tx.execute<RepoRow>(sql`
    SELECT g.id, g.connection_id, c.provider, g.base_url, g.full_name, g.default_branch,
           g.host_state, g.mirror_head_sha, g.mirror_commit_id, g.mirror_refreshed_at,
           g.mirror_attempted_at, g.mirror_next_at, g.mirror_failures, g.mirror_error,
           (g.mirror_lease_until IS NOT NULL AND g.mirror_lease_until > now()) AS refreshing
      FROM git_repositories g
      LEFT JOIN git_connections c ON c.team_id = g.team_id AND c.id = g.connection_id
     WHERE g.team_id = ${teamId} AND g.project_id = ${projectId}`);
  return res.rows[0];
}

async function viewOf(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  row: RepoRow,
  canManage: boolean,
): Promise<GitRepoView> {
  const commits = await tx.execute<{
    sha: string;
    author_name: string;
    authored_at: Date | string;
    message: string;
  }>(sql`
    SELECT sha, author_name, authored_at, message FROM git_repository_commits
     WHERE team_id = ${teamId} AND repository_id = ${row.id} ORDER BY position`);
  const reason = readOnlyReason(row.host_state, row.connection_id);
  return {
    project_id: projectId,
    repository_id: row.id,
    connection_id: row.connection_id,
    provider: row.provider,
    base_url: row.base_url,
    full_name: row.full_name,
    web_url: `${row.base_url}/${row.full_name}`,
    default_branch: row.default_branch,
    host_state: row.host_state,
    read_only: reason !== null,
    read_only_reason: reason,
    can_manage: canManage,
    mirror: {
      head_sha: row.mirror_head_sha,
      refreshed_at: iso(row.mirror_refreshed_at),
      attempted_at: iso(row.mirror_attempted_at),
      refreshing: row.refreshing,
      next_attempt_at: iso(row.mirror_next_at),
      // A running refresh counted itself already (pessimistic claim, review M1).
      failures: Math.max(0, Number(row.mirror_failures) - (row.refreshing ? 1 : 0)),
      // The claim's provisional `interrupted` is not a failure while that refresh runs.
      error:
        row.refreshing && row.mirror_error === "interrupted" ? null : failureView(row.mirror_error),
    },
    commits: commits.rows.map((c) => ({
      sha: c.sha,
      author_name: c.author_name,
      authored_at: new Date(c.authored_at).toISOString(),
      message: c.message,
    })),
  };
}

/** Whether opening the Repo should start a refresh (the timer would take it later anyway). */
function stale(row: RepoRow, now = Date.now()): boolean {
  if (row.connection_id === null || row.refreshing) return false;
  if (row.host_state !== "active" && row.host_state !== "archived") return false;
  if (row.mirror_next_at !== null && new Date(row.mirror_next_at).getTime() > now) return false;
  const last = row.mirror_attempted_at === null ? 0 : new Date(row.mirror_attempted_at).getTime();
  return now - last > GIT_MIRROR_OPEN_STALE_MS;
}

async function isAdmin(tx: KobeTx, viewer: Viewer): Promise<boolean> {
  return (await teamRoleFor(tx, viewer.teamId, viewer.userId)) === "team_admin";
}

/** `GET /v1/projects/{id}/repo`: the Repo as mirrored; a stale mirror refreshes in the background. */
export async function readRepo(
  deps: MirrorDeps,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitRepoView>> {
  const out = await withTeam(deps.db, viewer.teamId, async (tx) => {
    const access = await loadAccess(tx, viewer, projectId);
    if (!access) return { outcome: NOT_FOUND };
    const row =
      access.project.kind === "repo" ? await repoOf(tx, viewer.teamId, projectId) : undefined;
    if (!row) return { outcome: NOT_A_REPO };
    const view = await viewOf(tx, viewer.teamId, projectId, row, await isAdmin(tx, viewer));
    return { outcome: { ok: true as const, value: view }, kick: stale(row) ? row.id : undefined };
  });
  if (out.kick !== undefined) kickMirrorRefresh(deps, viewer.teamId, out.kick);
  return out.outcome;
}

/**
 * `POST /v1/projects/{id}/repo/refresh` (the panel's Refresh): a refresh now, past any back-off
 * (still under the connection's budget). Answers at once with the mirror as it is (`refreshing`).
 */
export async function refreshRepo(
  deps: MirrorDeps,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitRepoView>> {
  const rate = await limited(
    deps,
    `git-mirror-refresh:${viewer.userId}`,
    GIT_MIRROR_REFRESH_RATE,
    "Too many refreshes. Try again later.",
  );
  if (rate) return rate;
  const out = await withTeam(deps.db, viewer.teamId, async (tx) => {
    const access = await loadAccess(tx, viewer, projectId);
    if (!access) return { outcome: NOT_FOUND };
    const row =
      access.project.kind === "repo" ? await repoOf(tx, viewer.teamId, projectId) : undefined;
    if (!row) return { outcome: NOT_A_REPO };
    if (row.connection_id === null) {
      return {
        outcome: plain(
          409,
          "connection_removed",
          "The Repo's git connection was removed: it is read-only from its last mirror. A Workspace admin can relink it.",
        ),
      };
    }
    // Review L2: Refresh skips the doubling back-off, never the host's rate-limit reset, the
    // connection's budget window, or the wait between "not found" answers (R2-L2).
    const waitMs =
      row.mirror_next_at === null ? 0 : new Date(row.mirror_next_at).getTime() - Date.now();
    if (
      waitMs > 0 &&
      (row.mirror_error === "host_rate_limited" ||
        row.mirror_error === "connection_budget" ||
        // Review R2-L2: the "not found" answers that mark a Repo deleted stay spread out.
        row.mirror_error === "repository_not_found")
    ) {
      return {
        outcome: {
          ok: false as const,
          status: 429,
          body: {
            code: row.mirror_error,
            message: MIRROR_FAILURE_MESSAGES[row.mirror_error],
            retry_after_seconds: Math.ceil(waitMs / 1000),
          },
        },
      };
    }
    const view = await viewOf(tx, viewer.teamId, projectId, row, await isAdmin(tx, viewer));
    return { outcome: { ok: true as const, value: view }, kick: row.id };
  });
  if (out.kick !== undefined) kickMirrorRefresh(deps, viewer.teamId, out.kick);
  return out.outcome;
}

const STOP_STATUS: Readonly<Record<string, number>> = {
  connection_off: 409,
  host_not_allowed: 403,
  credential_unavailable: 502,
  git_unavailable: 503,
};

function hostFailure(err: unknown): Outcome<never> {
  if (err instanceof MirrorStop) {
    return plain(STOP_STATUS[err.code] ?? 502, err.code, MIRROR_FAILURE_MESSAGES[err.code]);
  }
  if (err instanceof GitHostError) {
    if (err.code === "not_found" || err.code === "invalid_request") {
      return plain(
        404,
        "repository_not_found",
        "That repository is not in the connection's organization, or the Workspace's credential cannot see it.",
      );
    }
    if (err.code === "auth_failed") {
      return plain(502, "credential_rejected", MIRROR_FAILURE_MESSAGES.credential_rejected);
    }
    if (err.code === "rate_limited") {
      return plain(502, "host_rate_limited", MIRROR_FAILURE_MESSAGES.host_rate_limited);
    }
  }
  return plain(502, "host_unreachable", MIRROR_FAILURE_MESSAGES.host_unreachable);
}

/**
 * `POST /v1/projects/{id}/repo/relink` (G20): a Workspace admin links the Repo to another
 * repository of a connected organization (or to the same one through a new connection after the
 * old one was removed). The host's default branch of that repository becomes the record: the next
 * refresh (started at once) mirrors it into the project. Never a public repository (G10), never
 * one that is already another project's Repo.
 */
export async function relinkRepo(
  deps: MirrorDeps,
  viewer: Viewer,
  projectId: string,
  body: GitRepoRelinkBody,
): Promise<Outcome<GitRepoView>> {
  const rate = await limited(
    deps,
    `git-mirror-manage:${viewer.userId}`,
    GIT_MIRROR_MANAGE_RATE,
    "Too many relinks and detaches. Try again later.",
  );
  if (rate) return rate;
  const first = await withTeam(deps.db, viewer.teamId, async (tx) => {
    const access = await loadAccess(tx, viewer, projectId);
    if (!access) return NOT_FOUND;
    if (!(await isAdmin(tx, viewer))) return ADMINS_ONLY;
    if (access.project.kind !== "repo" || !(await repoOf(tx, viewer.teamId, projectId))) {
      return NOT_A_REPO;
    }
    return undefined;
  });
  if (first) return first;
  let repo: GitRepository;
  let connectionId: string;
  let baseUrl: string;
  try {
    const opened = await openConnection(deps, viewer.teamId, body.connection_id);
    if (opened === "removed") {
      return plain(
        404,
        "connection_not_found",
        "No git connection with that id in this Workspace.",
      );
    }
    repo = await opened.adapter.getRepository({ name: body.repository });
    connectionId = opened.connection.id;
    baseUrl = opened.connection.baseUrl;
  } catch (err) {
    return hostFailure(err);
  }
  if (repo.visibility === "public") {
    return plain(
      422,
      "repository_public",
      "That repository is public: a Repo is never linked to a public repository.",
    );
  }
  const out = await withTeam(deps.db, viewer.teamId, async (tx) => {
    const access = await loadAccess(tx, viewer, projectId, { lock: true });
    if (!access) return { outcome: NOT_FOUND };
    // Review L7: the role again, under the lock.
    if (!(await isAdmin(tx, viewer))) return { outcome: ADMINS_ONLY };
    const current =
      access.project.kind === "repo" ? await repoOf(tx, viewer.teamId, projectId) : undefined;
    if (!current) return { outcome: NOT_A_REPO };
    const taken = await tx.execute<{ id: string; project_id: string | null }>(sql`
      SELECT id, project_id FROM git_repositories
       WHERE team_id = ${viewer.teamId} AND base_url = ${baseUrl} AND host_repo_id = ${repo.id}`);
    const existing = taken.rows[0];
    if (existing?.project_id && existing.project_id !== projectId) {
      return {
        outcome: plain(
          409,
          "repository_in_use",
          "That repository is already another project's Repo.",
        ),
      };
    }
    if (existing?.id !== current.id) {
      await tx.execute(sql`
        UPDATE git_repositories SET project_id = NULL, mirror_commit_id = NULL,
               mirror_requested_at = NULL, updated_at = now()
         WHERE team_id = ${viewer.teamId} AND id = ${current.id}`);
    }
    // Review M3: the project's head is the old repository's last mirror, maybe the only copy of
    // its files left (the repository may be gone). Another repository's link starts without a
    // mirror commit of its own, so its first refresh adds a commit on top and never drops that
    // one; it stays in the project's history. The same repository again keeps its own.
    await revokeLease(tx, viewer.teamId, current.id);
    const linked = await tx.execute<{ id: string }>(sql`
      INSERT INTO git_repositories
        (team_id, connection_id, base_url, host_repo_id, full_name, default_branch, project_id,
         origin, is_private, mirror_commit_id, mirror_requested_at, created_by)
      VALUES (${viewer.teamId}, ${connectionId}, ${baseUrl}, ${repo.id}, ${repo.fullName},
              ${repo.defaultBranch ?? current.default_branch}, ${projectId}, 'link', true,
              NULL, now(), ${viewer.userId})
      ON CONFLICT (team_id, base_url, host_repo_id) DO UPDATE
        SET connection_id = EXCLUDED.connection_id, full_name = EXCLUDED.full_name,
            default_branch = EXCLUDED.default_branch, project_id = EXCLUDED.project_id,
            host_state = 'active', is_private = true,
            mirror_commit_id = CASE WHEN git_repositories.id = ${current.id}
                                    THEN git_repositories.mirror_commit_id END,
            mirror_lease_owner = NULL, mirror_lease_until = NULL,
            mirror_head_sha = CASE WHEN git_repositories.id = ${current.id}
                                   THEN git_repositories.mirror_head_sha END,
            mirror_requested_at = now(), mirror_next_at = NULL, mirror_failures = 0,
            mirror_error = NULL, updated_at = now()
      RETURNING id`);
    const repositoryId = linked.rows[0]?.id;
    if (repositoryId === undefined) throw new Error("git_repositories upsert returned no row");
    await recordAudit(tx, {
      action: "git.repo.relinked",
      actor: { kind: "user", id: viewer.userId },
      teamId: viewer.teamId,
      target: {
        repositoryId,
        projectId,
        previousRepositoryId: current.id,
        connectionId,
        hostRepoId: repo.id,
      },
    });
    const row = await repoOf(tx, viewer.teamId, projectId);
    if (!row) throw new Error("relinked repository not found");
    return {
      outcome: { ok: true as const, value: await viewOf(tx, viewer.teamId, projectId, row, true) },
      kick: repositoryId,
    };
  });
  if (out.kick !== undefined) kickMirrorRefresh(deps, viewer.teamId, out.kick);
  return out.outcome;
}

/**
 * `POST /v1/projects/{id}/repo/detach` (G20): a Workspace admin turns the Repo back into an
 * ordinary project. One Kobe commit of the mirrored files starts its own history again (Kobe's
 * history cap and retention apply from then on); the repository stays on the host and its record
 * stays in the Git section, unlinked. Kobe changes nothing on the host.
 */
export async function detachRepo(
  deps: MirrorDeps,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<GitRepoDetached>> {
  const rate = await limited(
    deps,
    `git-mirror-manage:${viewer.userId}`,
    GIT_MIRROR_MANAGE_RATE,
    "Too many relinks and detaches. Try again later.",
  );
  if (rate) return rate;
  return withTeam(deps.db, viewer.teamId, async (tx): Promise<Outcome<GitRepoDetached>> => {
    const access = await loadAccess(tx, viewer, projectId, { lock: true });
    if (!access) return NOT_FOUND;
    if (!(await isAdmin(tx, viewer))) return ADMINS_ONLY;
    const row =
      access.project.kind === "repo" ? await repoOf(tx, viewer.teamId, projectId) : undefined;
    if (!row) return NOT_A_REPO;
    await tx.execute(sql`
      UPDATE projects SET kind = 'project', updated_at = now()
       WHERE team_id = ${viewer.teamId} AND id = ${projectId}`);
    await revokeLease(tx, viewer.teamId, row.id);
    await tx.execute(sql`
      UPDATE git_repositories SET project_id = NULL, mirror_commit_id = NULL,
             mirror_requested_at = NULL, updated_at = now()
       WHERE team_id = ${viewer.teamId} AND id = ${row.id}`);
    await tx.execute(sql`
      DELETE FROM git_repository_commits
       WHERE team_id = ${viewer.teamId} AND repository_id = ${row.id}`);
    const head = await headOf(tx, viewer.teamId, projectId);
    const written = await writeCommit(tx, {
      teamId: viewer.teamId,
      projectId,
      tree: await loadTree(tx, viewer.teamId, head?.id ?? null),
      author: { userId: viewer.userId, kind: "user" },
      message: `Detached from ${row.full_name}`,
    });
    await recordAudit(tx, {
      action: "git.repo.detached",
      actor: { kind: "user", id: viewer.userId },
      teamId: viewer.teamId,
      target: { repositoryId: row.id, projectId, commitId: written.commitId },
    });
    return {
      ok: true,
      value: { project_id: projectId, commit_id: written.commitId, seq: written.seq },
    };
  });
}
