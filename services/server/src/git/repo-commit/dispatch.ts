import { withTeam } from "@kobe/db";
import {
  commitWorkingCopy,
  previewCommit,
  type CommitDeps,
  type CommitRequest,
  type CommitResult,
} from "../../projects/commits.js";
import { projectWriteBlock } from "../../projects/repo-state.js";
import { commitToRepo, type RepoCommitDeps, type RepoCommitRequest } from "./commit.js";

/**
 * Kaiju's commit flow for any project (KOBE-767): a Repo's commit goes to its git host
 * ({@link commitToRepo}); every other project's becomes Kaiju's next commit as before. Without the
 * git dependencies (a server without git hosts) a Repo still refuses as before (`repo`).
 */
export type RepoCommitWiring = Omit<RepoCommitDeps, "commit">;

/** KOBE-767: the words of a Repo commit refusal without a more precise reason. */
export const REPO_REFUSAL_MESSAGES = {
  repo_moved:
    "The Repo's default branch moved on the git host since Kaiju's copy. Update, then commit again.",
  repo_unavailable: "The Repo can't take a commit now.",
  repo_push_rejected: "The git host refused the push.",
} as const;

export async function commitProject(
  commit: CommitDeps,
  repo: RepoCommitWiring | undefined,
  req: RepoCommitRequest,
): Promise<CommitResult> {
  const { via: _via, approvedAs: _approvedAs, ...plain } = req;
  if (repo !== undefined) {
    const block = await withTeam(commit.db, req.owner.teamId, (tx) =>
      projectWriteBlock(tx, req.owner.teamId, req.projectId),
    );
    if (block === "repo") return commitToRepo({ ...repo, commit }, req);
  }
  return commitWorkingCopy(commit, plain satisfies CommitRequest);
}

/** The agent's approval preview (CM6) for any project, a Repo included when git is wired. */
export function previewProjectCommit(
  commit: CommitDeps,
  repo: RepoCommitWiring | undefined,
  req: Pick<CommitRequest, "owner" | "projectId">,
): ReturnType<typeof previewCommit> {
  return previewCommit(commit, req, { repo: repo !== undefined });
}
