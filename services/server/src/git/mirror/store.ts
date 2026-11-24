import { SYSTEM_ACTOR, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import {
  GIT_MIRROR_FAILURES,
  type GitMirrorFailure,
  type GitRepoHostState,
  type GitRepoReadOnlyReason,
} from "@kaiju/protocol";
import { recordAudit } from "../../audit/record.js";
import {
  GIT_REPO_MAX_CONTENT_BYTES,
  GIT_REPO_MAX_FILE_BYTES,
  GIT_REPO_MAX_FILES,
} from "../repo-limits.js";
import {
  GIT_MIRROR_BACKOFF_BASE_MS,
  GIT_MIRROR_BACKOFF_MAX_MS,
  GIT_MIRROR_LEASE_MS,
  GIT_MIRROR_PUSH_DELAY_MS,
} from "./limits.js";

/**
 * Reads and writes of the Repo mirror's state on `git_repositories` (KOBE-766). Every write is a
 * short `withTeam()` transaction; the refresh's writes name the lease they hold
 * (`mirror_lease_owner`), so a replica whose claim lapsed changes nothing ({@link MirrorLeaseLost}).
 */
export interface MirrorRow {
  readonly teamId: string;
  readonly id: string;
  readonly connectionId: string | null;
  readonly baseUrl: string;
  readonly hostRepoId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly projectId: string;
  readonly hostState: GitRepoHostState;
  readonly mirrorHeadSha: string | null;
  readonly mirrorCommitId: string | null;
  /** Failures in a row and the last failure code before this claim. */
  readonly mirrorFailures: number;
  readonly mirrorError: string | null;
  readonly createdBy: string;
}

export interface MirrorLease {
  readonly teamId: string;
  readonly id: string;
  readonly owner: string;
}

export class MirrorLeaseLost extends Error {
  constructor() {
    super("mirror lease lost");
    this.name = "MirrorLeaseLost";
  }
}

type RawRow = {
  team_id: string;
  id: string;
  connection_id: string | null;
  base_url: string;
  host_repo_id: string;
  full_name: string;
  default_branch: string;
  project_id: string;
  host_state: GitRepoHostState;
  mirror_head_sha: string | null;
  mirror_commit_id: string | null;
  mirror_failures: number;
  mirror_error: string | null;
  created_by: string;
};

const toRow = (r: RawRow): MirrorRow => ({
  teamId: r.team_id,
  id: r.id,
  connectionId: r.connection_id,
  baseUrl: r.base_url,
  hostRepoId: r.host_repo_id,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  projectId: r.project_id,
  hostState: r.host_state,
  mirrorHeadSha: r.mirror_head_sha,
  mirrorCommitId: r.mirror_commit_id,
  mirrorFailures: Number(r.mirror_failures),
  mirrorError: r.mirror_error,
  createdBy: r.created_by,
});

/**
 * Takes the refresh of one Repo for `owner`: free (no live lease) and linked to a project.
 *
 * Pessimistic (review M1): the claim already counts the attempt as a failure, sets the back-off
 * and, when there was no failure code, `interrupted`; a refresh that ends settles them (success,
 * failure or deferral). So a refresh whose process dies (out of memory, a crash, an eviction)
 * still backs off instead of being retried at once when its lease lapses. A request that is due
 * is cleared; one still in the future (a push's) is kept (review L6). Returns the row as it was
 * before the claim; `busy` when another run holds it.
 */
export async function claimRefresh(
  db: KaijuDb,
  teamId: string,
  repositoryId: string,
  owner: string,
): Promise<MirrorRow | "busy"> {
  const base = GIT_MIRROR_BACKOFF_BASE_MS / 1000;
  const max = GIT_MIRROR_BACKOFF_MAX_MS / 1000;
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<RawRow>(sql`
      WITH old AS (
        SELECT team_id, id, connection_id, base_url, host_repo_id, full_name, default_branch,
               project_id, host_state, mirror_head_sha, mirror_commit_id, mirror_failures,
               mirror_error, created_by
          FROM git_repositories
         WHERE team_id = ${teamId} AND id = ${repositoryId} AND project_id IS NOT NULL
           AND (mirror_lease_until IS NULL OR mirror_lease_until < now())
           FOR UPDATE)
      UPDATE git_repositories g
         SET mirror_lease_owner = ${owner},
             mirror_lease_until = now() + ${sql.raw(`interval '${GIT_MIRROR_LEASE_MS} milliseconds'`)},
             mirror_attempted_at = now(),
             mirror_requested_at = CASE WHEN g.mirror_requested_at <= now() THEN NULL
                                        ELSE g.mirror_requested_at END,
             mirror_failures = g.mirror_failures + 1,
             mirror_next_at = now() + make_interval(secs => LEAST(${sql.raw(String(base))} * power(2, LEAST(g.mirror_failures, 20)), ${sql.raw(String(max))})),
             mirror_error = COALESCE(g.mirror_error, 'interrupted')
        FROM old
       WHERE g.team_id = old.team_id AND g.id = old.id
       RETURNING old.*`);
    const row = res.rows[0];
    return row ? toRow(row) : "busy";
  });
}

/** Runs `work` on the repository row only while `lease` still holds it. */
export async function underLease<T>(
  tx: KaijuTx,
  lease: MirrorLease,
  work: () => Promise<T>,
): Promise<T> {
  const res = await tx.execute(sql`
    SELECT 1 FROM git_repositories
     WHERE team_id = ${lease.teamId} AND id = ${lease.id} AND mirror_lease_owner = ${lease.owner}
       FOR UPDATE`);
  if (res.rows.length === 0) throw new MirrorLeaseLost();
  return work();
}

const RELEASE = sql.raw(`mirror_lease_owner = NULL, mirror_lease_until = NULL`);

/** A refresh that failed: the code, failures in a row, the earliest next try. */
export async function recordFailure(
  db: KaijuDb,
  lease: MirrorLease,
  row: Pick<MirrorRow, "mirrorFailures">,
  code: GitMirrorFailure,
  nextAt: Date,
  countsAsFailure: boolean,
): Promise<void> {
  await withTeam(db, lease.teamId, (tx) =>
    tx.execute(sql`
      UPDATE git_repositories
         SET mirror_error = ${code}, mirror_next_at = ${nextAt.toISOString()}::timestamptz,
             mirror_failures = ${row.mirrorFailures + (countsAsFailure ? 1 : 0)}, ${RELEASE}
       WHERE team_id = ${lease.teamId} AND id = ${lease.id}
         AND mirror_lease_owner = ${lease.owner}`),
  );
}

/** The host's view of the repository changed (name, branch, state); audited when the state did. */
export async function recordHostFacts(
  tx: KaijuTx,
  row: MirrorRow,
  facts: {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly hostState: GitRepoHostState;
    readonly isPrivate?: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE git_repositories
       SET full_name = ${facts.fullName}, default_branch = ${facts.defaultBranch},
           host_state = ${facts.hostState},
           is_private = COALESCE(${facts.isPrivate ?? null}::boolean, is_private),
           updated_at = now()
     WHERE team_id = ${row.teamId} AND id = ${row.id}`);
  if (facts.hostState !== row.hostState) {
    await recordAudit(tx, {
      action: "git.repo.host_state_changed",
      actor: SYSTEM_ACTOR,
      teamId: row.teamId,
      target: {
        repositoryId: row.id,
        projectId: row.projectId,
        hostRepoId: row.hostRepoId,
        from: row.hostState,
        to: facts.hostState,
      },
    });
  }
}

/** A refresh that succeeded: failures cleared, the lease released. */
export async function recordSuccess(
  tx: KaijuTx,
  lease: MirrorLease,
  mirror: {
    readonly headSha: string;
    readonly commitId?: string | null;
    /**
     * KOBE-767: the mirror head the refresh started from. When Kaiju's commit flow moved the head
     * meanwhile (a direct commit written into Kaiju's copy), the head and commit are left as they
     * are: this refresh read an older state and must not put it back.
     */
    readonly fromHead?: string | null;
  },
): Promise<void> {
  const commit =
    mirror.commitId === undefined
      ? sql``
      : mirror.fromHead === undefined
        ? sql`mirror_commit_id = ${mirror.commitId},`
        : sql`mirror_commit_id = CASE WHEN mirror_head_sha IS NOT DISTINCT FROM ${mirror.fromHead}
                THEN ${mirror.commitId}::uuid ELSE mirror_commit_id END,`;
  const head =
    mirror.fromHead === undefined
      ? sql`${mirror.headSha}`
      : sql`CASE WHEN mirror_head_sha IS NOT DISTINCT FROM ${mirror.fromHead}
              THEN ${mirror.headSha} ELSE mirror_head_sha END`;
  await tx.execute(sql`
    UPDATE git_repositories
       SET mirror_head_sha = ${head}, ${commit} mirror_refreshed_at = now(),
           mirror_error = NULL, mirror_failures = 0, mirror_next_at = NULL, ${RELEASE},
           updated_at = now()
     WHERE team_id = ${lease.teamId} AND id = ${lease.id} AND mirror_lease_owner = ${lease.owner}`);
}

/**
 * Releases the lease with a settled outcome that is not a mirror write: the repository is gone
 * for good or its connection was removed (failures cleared; the slow re-check finds it again), or
 * the Repo was unlinked meanwhile.
 */
export async function releaseLease(tx: KaijuTx, lease: MirrorLease): Promise<void> {
  await tx.execute(sql`
    UPDATE git_repositories
       SET mirror_failures = 0, mirror_error = NULL, mirror_next_at = NULL, ${RELEASE}
     WHERE team_id = ${lease.teamId} AND id = ${lease.id} AND mirror_lease_owner = ${lease.owner}`);
}

/** Relink and detach end any refresh in flight: its later writes are refused (review L5). */
export async function revokeLease(tx: KaijuTx, teamId: string, repositoryId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE git_repositories SET ${RELEASE}
     WHERE team_id = ${teamId} AND id = ${repositoryId}`);
}

/**
 * Asks for a refresh of a Repo, due after `delayMs` (a push decided now lands a moment later).
 * The mirror job takes it on its next pass. Returns whether a Repo matched.
 */
export async function requestMirrorRefresh(
  tx: KaijuTx,
  teamId: string,
  match:
    { readonly repositoryId: string } | { readonly baseUrl: string; readonly hostRepoId: string },
  delayMs = 0,
): Promise<boolean> {
  const where =
    "repositoryId" in match
      ? sql`id = ${match.repositoryId}`
      : sql`base_url = ${match.baseUrl} AND host_repo_id = ${match.hostRepoId}`;
  const res = await tx.execute(sql`
    UPDATE git_repositories
       SET mirror_requested_at = CASE
             WHEN mirror_requested_at > now() THEN mirror_requested_at
             ELSE now() + ${sql.raw(`interval '${Math.max(0, Math.floor(delayMs))} milliseconds'`)} END
     WHERE team_id = ${teamId} AND ${where} AND project_id IS NOT NULL
     RETURNING id`);
  return res.rows.length > 0;
}

/** A push through the egress proxy was allowed to a Repo: refresh it once the push landed. */
export async function requestPushRefresh(
  db: KaijuDb,
  teamId: string,
  baseUrl: string,
  hostRepoId: string,
): Promise<boolean> {
  return withTeam(db, teamId, (tx) =>
    requestMirrorRefresh(tx, teamId, { baseUrl, hostRepoId }, GIT_MIRROR_PUSH_DELAY_MS),
  );
}

/** The read-only reason of a Repo's host state (G20); null while the repository is there. */
export function readOnlyReason(
  hostState: GitRepoHostState,
  connectionId: string | null,
): GitRepoReadOnlyReason | null {
  if (connectionId === null || hostState === "unreachable") return "connection_removed";
  if (hostState === "deleted") return "deleted";
  if (hostState === "archived") return "archived";
  return null;
}

/**
 * Whether a Repo is read-only because its host repository went away (G20), for the commit flow
 * (KOBE-767): null for an ordinary project or a Repo whose repository is there.
 */
export async function repoReadOnly(
  tx: KaijuTx,
  teamId: string,
  projectId: string,
): Promise<GitRepoReadOnlyReason | null> {
  const res = await tx.execute<{ host_state: GitRepoHostState; connection_id: string | null }>(sql`
    SELECT host_state, connection_id FROM git_repositories
     WHERE team_id = ${teamId} AND project_id = ${projectId}`);
  const row = res.rows[0];
  return row ? readOnlyReason(row.host_state, row.connection_id) : null;
}

const isFailure = (code: string | null): code is GitMirrorFailure =>
  code !== null && (GIT_MIRROR_FAILURES as readonly string[]).includes(code);

const mib = (n: number) => `${Math.floor(n / (1024 * 1024))} MiB`;

export const MIRROR_FAILURE_MESSAGES: Readonly<Record<GitMirrorFailure, string>> = {
  connection_off: "The git connection is turned off; a Workspace admin can turn it back on.",
  host_not_allowed: "This Site no longer allows the repository's git host.",
  credential_unavailable:
    "The Workspace's git credential could not be opened; a Workspace admin should replace it.",
  credential_rejected:
    "The git host refused the Workspace's credential; a Workspace admin should check the connection.",
  credential_forbidden: "The Workspace's git credential may not read this repository.",
  connection_budget:
    "The connection's hourly budget for git reads is used up (it is shared with agents' git tools); Kaiju tries again later.",
  host_rate_limited: "The git host is rate limiting Kaiju; Kaiju tries again after its reset time.",
  host_unreachable: "The git host could not be reached; Kaiju tries again later.",
  branch_missing: "The repository's default branch is not on the host.",
  too_many_files: `The repository is too large to mirror: it has more than ${GIT_REPO_MAX_FILES} files. Kaiju keeps showing the last mirror and checks again every few hours; the repository itself is unchanged on the host.`,
  file_too_large: `The repository is too large to mirror: it holds a file over ${mib(GIT_REPO_MAX_FILE_BYTES)}. Kaiju keeps showing the last mirror and checks again every few hours; the repository itself is unchanged on the host.`,
  repository_too_large: `The repository is too large to mirror: its files, or its recent history, are more than a mirror can hold (${mib(GIT_REPO_MAX_CONTENT_BYTES)} of files). Kaiju keeps showing the last mirror and checks again every few hours; the repository itself is unchanged on the host.`,
  unsupported_path: "The repository holds a file whose path Kaiju's projects cannot hold.",
  fetch_failed: "Kaiju could not read the repository from the host; it tries again later.",
  server_capacity: "The server has no room to read the repository now; Kaiju tries again later.",
  legal_hold:
    "A legal hold covers this Workspace and the change would remove files, so the mirror waits.",
  git_unavailable: "Git is not available on this server.",
  repository_not_found:
    "The host does not show this repository to the Workspace's credential (deleted, moved out of the organization, or access narrowed); Kaiju checks again before marking it deleted.",
  interrupted: "The last refresh stopped before it finished; Kaiju tries again later.",
  internal_error: "The mirror could not be refreshed; Kaiju tries again later.",
};

export function failureView(
  code: string | null,
): { code: GitMirrorFailure; message: string } | null {
  if (code === null) return null;
  const known: GitMirrorFailure = isFailure(code) ? code : "internal_error";
  return { code: known, message: MIRROR_FAILURE_MESSAGES[known] };
}
