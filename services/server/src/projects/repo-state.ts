import { sql, type KobeTx } from "@kobe/db";

/**
 * Whether Kaiju may write a project's files now (KOBE-765, spec workspace-git G16, G17, GQ4).
 *
 * - `repo`: the project was converted to a Repo. Its record is the repository on the git host and
 *   Kaiju keeps a mirror of the default branch (G17, GQ4: "Kaiju's commits stop for that project").
 *   Every direct Kaiju write refuses: revert, upload, Add to project, an accepted proposal,
 *   removing a file. A commit from Kaiju's commit flow goes to the host instead (KOBE-767,
 *   `git/repo-commit`), and Kaiju's copy takes it only through `writeCommit`'s `repoMirror`.
 * - `converting`: a conversion is running, or failed and waits for a retry or abandon. The
 *   history being written to the host must not move under it.
 *
 * {@link writeCommit} checks this itself (every write of a project's files goes through it), so a
 * path that forgets the early check still cannot write; the early checks only give the precise
 * refusal before any bytes move. Callers hold the project row lock where they write, and a
 * conversion is started under the same lock, so the two cannot interleave.
 */
export type ProjectWriteBlock = "repo" | "converting";

export async function projectWriteBlock(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<ProjectWriteBlock | null> {
  const res = await tx.execute<{ kind: string; converting: boolean }>(sql`
    SELECT p.kind,
           EXISTS (SELECT 1 FROM git_conversions g
                    WHERE g.team_id = p.team_id AND g.project_id = p.id
                      AND g.status IN ('running', 'failed')) AS converting
      FROM projects p
     WHERE p.team_id = ${teamId} AND p.id = ${projectId}`);
  const row = res.rows[0];
  if (!row) return null;
  if (row.kind === "repo") return "repo";
  return row.converting ? "converting" : null;
}

/** Thrown by `writeCommit` for a blocked project; its transaction rolls back. */
export class ProjectWriteBlocked extends Error {
  constructor(readonly block: ProjectWriteBlock) {
    super(`project writes are off: ${block}`);
    this.name = "ProjectWriteBlocked";
  }
}

/** What a member (and the model, for the agent's commit tool) is told. */
export const PROJECT_WRITE_BLOCK_MESSAGES: Readonly<Record<ProjectWriteBlock, string>> = {
  repo: "This project is a Repo: its record is the repository on the git host, so its files change only through a git commit. Check it out and use Commit… (a pull request on the host), or change it on the host.",
  converting:
    "This project is being converted to a Repo: its files can't change until the conversion finishes or is abandoned.",
};

/** The error code the REST answers use. */
export const PROJECT_WRITE_BLOCK_CODES: Readonly<Record<ProjectWriteBlock, string>> = {
  repo: "project_is_repo",
  converting: "conversion_in_progress",
};
