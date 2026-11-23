import {
  SYSTEM_ACTOR,
  isLegalHoldViolation,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import {
  diffVersions,
  headOf,
  loadTree,
  queueProjectBlobs,
  referencedKeys,
  refreshProjectStorage,
  writeCommit,
  type Tree,
} from "../../projects/tree.js";
import type { MirrorCommit } from "./fetch.js";
import {
  recordSuccess,
  releaseLease,
  underLease,
  type MirrorLease,
  type MirrorRow,
} from "./store.js";

/**
 * Writing a refresh into the Repo (KOBE-766, G17), in one transaction under the lease and the
 * project row lock (the lock every Kobe write takes): when the host's files differ from the
 * project's head, one Kobe commit of them (so mounts, the Files panel, search and the commit
 * flow's conflict check see the host's state), the previous mirror commit dropped unless a
 * working copy is based on it or a legal hold covers the Workspace (the Repo's history lives on
 * the host, G17), the commit list replaced, and the mirror's head recorded. Nothing is written
 * when the project stopped being this repository's Repo meanwhile (detached or relinked).
 */
export class MirrorHeld extends Error {
  constructor() {
    super("legal hold: the mirror would remove files");
    this.name = "MirrorHeld";
  }
}

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly commitId: string | null; readonly changed: number }
  | { readonly kind: "gone" };

async function teamHeld(tx: KobeTx, teamId: string): Promise<boolean> {
  const res = await tx.execute<{ held: boolean }>(
    sql`SELECT public.memory_legal_hold_covers(${teamId}, NULL) AS held`,
  );
  return res.rows[0]?.held === true;
}

/** Drops the mirror's previous commit when nothing needs it any more. */
async function prunePrevious(tx: KobeTx, row: MirrorRow, previous: string): Promise<void> {
  await lockLegalHolds(tx);
  if (await teamHeld(tx, row.teamId)) return;
  const refs = await tx.execute<{ key: string }>(sql`
    SELECT DISTINCT blob_ref AS key FROM project_tree_entries
     WHERE team_id = ${row.teamId} AND commit_id = ${previous}`);
  const gone = await tx.execute<{ id: string }>(sql`
    DELETE FROM project_commits c
     WHERE c.team_id = ${row.teamId} AND c.project_id = ${row.projectId} AND c.id = ${previous}
       AND c.id IS DISTINCT FROM (SELECT head_commit_id FROM projects
                                   WHERE team_id = ${row.teamId} AND id = ${row.projectId})
       AND NOT EXISTS (SELECT 1 FROM project_checkouts k
                        WHERE k.team_id = c.team_id AND k.project_id = c.project_id
                          AND k.base_commit_id = c.id)
     RETURNING id`);
  if (gone.rows.length === 0) return;
  const keys = refs.rows.map((r) => r.key);
  const still = await referencedKeys(tx, row.teamId, row.projectId, keys);
  await queueProjectBlobs(
    tx,
    row.teamId,
    row.projectId,
    row.createdBy,
    keys.filter((k) => !still.has(k)),
  );
  await refreshProjectStorage(tx, row.teamId, row.projectId);
}

async function replaceCommits(
  tx: KobeTx,
  row: MirrorRow,
  commits: readonly MirrorCommit[],
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM git_repository_commits WHERE team_id = ${row.teamId} AND repository_id = ${row.id}`);
  if (commits.length === 0) return;
  await tx.execute(sql`
    INSERT INTO git_repository_commits
      (team_id, repository_id, position, sha, author_name, authored_at, message)
    VALUES ${sql.join(
      commits.map(
        (c, i) =>
          sql`(${row.teamId}, ${row.id}, ${i}, ${c.sha}, ${c.authorName}, ${c.authoredAt.toISOString()}::timestamptz, ${c.message})`,
      ),
      sql`, `,
    )}`);
}

export async function applyMirror(
  db: KobeDb,
  lease: MirrorLease,
  row: MirrorRow,
  input: {
    readonly head: string;
    readonly tree: Tree;
    readonly commits: readonly MirrorCommit[];
    readonly skipped: number;
  },
): Promise<ApplyOutcome> {
  return withTeam(db, lease.teamId, async (tx) => {
    // The project row first, then the repository row: the order relink and detach take them in.
    const project = await tx.execute<{ kind: string }>(sql`
      SELECT kind FROM projects WHERE team_id = ${lease.teamId} AND id = ${row.projectId}
         FOR UPDATE`);
    return underLease(tx, lease, async (): Promise<ApplyOutcome> => {
      const linked = await tx.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM git_repositories
         WHERE team_id = ${lease.teamId} AND id = ${lease.id}`);
      if (project.rows[0]?.kind !== "repo" || linked.rows[0]?.project_id !== row.projectId) {
        await releaseLease(tx, lease);
        return { kind: "gone" };
      }
      const head = await headOf(tx, row.teamId, row.projectId);
      const changes = diffVersions(await loadTree(tx, row.teamId, head?.id ?? null), input.tree);
      let commitId: string | null = null;
      if (changes.length > 0) {
        try {
          const written = await writeCommit(tx, {
            teamId: row.teamId,
            projectId: row.projectId,
            tree: input.tree,
            author: { userId: row.createdBy, kind: "user" },
            message: `Mirror of ${row.fullName} at ${input.head.slice(0, 12)}`,
            audit: false,
            mirror: true,
          });
          commitId = written.commitId;
        } catch (err) {
          if (isLegalHoldViolation(err)) throw new MirrorHeld();
          throw err;
        }
        if (row.mirrorCommitId !== null) await prunePrevious(tx, row, row.mirrorCommitId);
      }
      await replaceCommits(tx, row, input.commits);
      await recordSuccess(tx, lease, {
        headSha: input.head,
        ...(commitId === null ? {} : { commitId }),
      });
      if (commitId !== null) {
        await recordAudit(tx, {
          action: "git.repo.mirror_updated",
          actor: SYSTEM_ACTOR,
          teamId: row.teamId,
          target: {
            repositoryId: row.id,
            projectId: row.projectId,
            commitId,
            headSha: input.head,
            added: changes.filter((c) => c.change === "added").length,
            modified: changes.filter((c) => c.change === "modified").length,
            deleted: changes.filter((c) => c.change === "deleted").length,
            fileCount: input.tree.size,
            skipped: input.skipped,
          },
        });
      }
      return { kind: "applied", commitId, changed: changes.length };
    });
  });
}
