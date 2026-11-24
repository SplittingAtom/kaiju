/** Why a Repo mirror refresh cannot complete (KOBE-766). */
export type MirrorErrorCode =
  /** The default branch is not on the host (renamed, or the repository is empty). */
  | "branch_missing"
  | "too_many_files"
  | "file_too_large"
  | "repository_too_large"
  /** A path Kaiju's projects cannot hold (too long once mounted, or not a valid workspace path). */
  | "unsupported_path"
  | "fetch_failed"
  /** The server has no room for the fetch now. */
  | "server_capacity";

/** A refresh that cannot complete; `detail` names the path or size when one is to blame. */
export class MirrorError extends Error {
  constructor(
    readonly code: MirrorErrorCode,
    readonly detail?: string,
  ) {
    super(`git mirror: ${code}`);
    this.name = "MirrorError";
  }
}
