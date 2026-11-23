import type { GitConversionFailure, GitConversionRefusal } from "@kobe/protocol";

/**
 * Convert to repo's refusals (before anything starts) and failures (a step that failed), with the
 * words the dialog shows (G16: "the dialog says which") and the REST status of a refusal.
 */

export interface StartRefusal {
  readonly code: GitConversionRefusal;
  readonly path?: string;
  readonly seq?: number;
  readonly checkouts?: number;
  readonly limitBytes?: number;
}

const mib = (n: number) => `${Math.floor(n / (1024 * 1024))} MiB`;

export const REFUSAL_STATUS: Readonly<Record<GitConversionRefusal, 403 | 404 | 409 | 422 | 503>> = {
  already_repo: 409,
  conversion_in_progress: 409,
  archived: 409,
  legal_hold: 409,
  unsaved_checkouts: 409,
  connection_not_found: 404,
  connection_read_only: 409,
  cannot_create_repositories: 422,
  git_disabled: 403,
  host_not_allowed: 403,
  internal_not_offered: 422,
  invalid_repository_name: 422,
  file_rejected_by_host: 422,
  project_too_large: 422,
  commit_too_large: 422,
  git_unavailable: 503,
};

export function refusalMessage(r: StartRefusal): string {
  switch (r.code) {
    case "already_repo":
      return "This project is already a Repo.";
    case "conversion_in_progress":
      return "This project already has a conversion that is running or failed: retry or abandon it first.";
    case "archived":
      return "The project is archived. Unarchive it before converting it.";
    case "legal_hold":
      return "The Workspace is under a legal hold, so the project can't be converted now.";
    case "unsaved_checkouts":
      return `${r.checkouts ?? 1} working ${r.checkouts === 1 ? "copy holds" : "copies hold"} changes that are not committed. Commit or discard them first.`;
    case "connection_not_found":
      return "That git connection does not exist in this Workspace.";
    case "connection_read_only":
      return "Converting needs the git connection at Read and write. A Workspace admin can change that in the Git section.";
    case "cannot_create_repositories":
      return "The connection's credential may not create repositories in the organization. A Workspace admin can grant that, or choose an existing empty repository.";
    case "git_disabled":
      return "Git connections are turned off for this Site.";
    case "host_not_allowed":
      return "This Site does not allow that git host.";
    case "internal_not_offered":
      return "Internal visibility is not available for this connection: choose private.";
    case "invalid_repository_name":
      return "That is not a valid repository name: letters, digits, '.', '-' and '_' only, at most 100 characters, not ending in .git.";
    case "file_rejected_by_host":
      return `The git host would reject a file of this project (${r.path ?? "a file"}): rename or remove it first.`;
    case "project_too_large":
      return `The project's files are more than one conversion may push (${mib(r.limitBytes ?? 0)}).`;
    case "commit_too_large":
      return r.seq === undefined
        ? `The project's current files are more than one push may carry (${mib(r.limitBytes ?? 0)}). Convert without them, or make the project smaller first.`
        : `Commit #${r.seq} adds more than one push may carry (${mib(r.limitBytes ?? 0)}). Convert without history instead.`;
    case "git_unavailable":
      return "Converting is not available on this server (no credential key or file storage).";
  }
}

export const FAILURE_MESSAGES: Readonly<Record<GitConversionFailure, string>> = {
  repository_exists:
    "A repository with that name already exists in the organization. Abandon this attempt and convert again with another name, or choose it as an existing empty repository.",
  repository_not_empty:
    "The repository is not empty, so Kobe will not write into it. Abandon this attempt and choose another name.",
  repository_gone:
    "The repository is not on the host (deleted, or moved out of the organization). Abandon this attempt and convert again.",
  repository_public:
    "The chosen repository is public, and Kobe never writes a project into a public repository. Abandon this attempt and choose a private one.",
  repository_changed:
    "Someone pushed other commits to the repository while it was being written. Abandon this attempt, or reset the repository's default branch on the host and retry.",
  default_branch_mismatch:
    "The repository's default branch on the host is not the branch Kobe pushed. Set it on the host, then retry.",
  content_missing:
    "A file of the project could not be read from Kobe's storage. Try again later; if it keeps failing, tell your Site admin.",
  connection_unavailable:
    "The git connection was removed, is no longer at Read and write, or the Site no longer allows its host. Retry once it is back.",
  credential_rejected:
    "The git host refused the Workspace's credential. A Workspace admin should check the connection, then retry.",
  credential_forbidden:
    "The Workspace's credential is not allowed to do that on the host. A Workspace admin should check its permissions, then retry.",
  push_rejected:
    "The git host refused the push (a rule on the host, such as a size or file limit). Retry after fixing it on the host, or abandon.",
  host_unreachable: "The git host could not be reached. Retry shortly.",
  host_rate_limited: "The git host is rate limiting Kobe. Retry later.",
  project_changed:
    "The project changed while it was being converted. Retry to carry the new commits too.",
  internal_error: "The conversion stopped on an unexpected error. Retry, or abandon it.",
};
