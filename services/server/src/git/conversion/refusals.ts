import type { GitConversionFailure, GitConversionRefusal } from "@kobe/protocol";
import { GIT_REPO_MAX_FILES } from "../repo-limits.js";
import { GIT_CONVERSION_MAX_BYTES } from "./limits.js";

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
  readonly sizeBytes?: number;
  readonly paths?: readonly { readonly path: string; readonly seq: number | null }[];
  /** `too_large_to_mirror`: which Repo limit (not sent; it picks the message). */
  readonly mirrorLimit?: "files" | "file_bytes" | "bytes";
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
  existing_repository_admin_only: 403,
  file_rejected_by_host: 422,
  project_too_large: 422,
  file_too_large: 422,
  too_large_to_mirror: 422,
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
    case "existing_repository_admin_only":
      return "Only Workspace admins may choose an existing repository; convert into a new one instead.";
    case "file_rejected_by_host": {
      const list = (r.paths ?? (r.path === undefined ? [] : [{ path: r.path, seq: null }]))
        .map((p) => (p.seq === null ? p.path : `${p.path} (from commit #${p.seq})`))
        .join(", ");
      return `The git host would reject ${r.paths && r.paths.length > 1 ? "these files" : "this file"}: ${list || "a file"}. Rename or remove it in the project first; if only older commits have it, convert without history.`;
    }
    case "too_large_to_mirror":
      return r.mirrorLimit === "files"
        ? `The project has more files than a Repo's mirror can show (${GIT_REPO_MAX_FILES}). Remove some files before converting.`
        : r.mirrorLimit === "file_bytes"
          ? `A file is larger than a Repo's mirror can show (${mib(r.limitBytes ?? 0)} per file). Remove or shrink it before converting.`
          : `The project's current files (${mib(r.sizeBytes ?? 0)}) are more than a Repo's mirror can show (${mib(r.limitBytes ?? 0)}): after converting, Kaiju could not show the repository's changes. Remove large files before converting.`;
    case "project_too_large":
      return `The project's files across the history carried (${mib(r.sizeBytes ?? 0)}) are more than one conversion may push (${mib(r.limitBytes ?? 0)}). Convert without history if the current files are smaller, remove large files, or ask a Workspace admin to raise the connection's push limit (up to ${mib(GIT_CONVERSION_MAX_BYTES)}).`;
    case "file_too_large": {
      const list = (r.paths ?? (r.path === undefined ? [] : [{ path: r.path, seq: null }]))
        .map((p) => (p.seq === null ? p.path : `${p.path} (from commit #${p.seq})`))
        .join(", ");
      return `Git hosts refuse files over ${mib(r.limitBytes ?? 0)}: ${list || "a file"}. Remove ${r.paths && r.paths.length > 1 ? "them" : "it"} from the project first (if only older commits have it, convert without history); large-file storage on the host is not available from Kaiju yet.`;
    }
    case "git_unavailable":
      return "Converting is not available on this server (no credential key or file storage).";
  }
}

export const FAILURE_MESSAGES: Readonly<Record<GitConversionFailure, string>> = {
  repository_exists:
    "A repository with that name already exists in the organization. Abandon this attempt and convert again with another name, or choose it as an existing empty repository.",
  repository_not_empty:
    "The repository is not empty, so Kaiju will not write into it. Abandon this attempt and choose another name.",
  repository_gone:
    "The repository is not on the host (deleted, or moved out of the organization). Abandon this attempt and convert again.",
  repository_in_use:
    "The chosen repository carries another Kaiju conversion's mark, so it may already be a Repo of another Workspace. Choose another repository.",
  file_rejected_by_host:
    "A file of the project is one the git host refuses (see the detail). Rename or remove it, then convert again; if only older commits have it, convert without history.",
  interrupted:
    "The conversion stopped its server more than once without making progress, so Kaiju no longer resumes it on its own. Retry once the cause is fixed, or abandon it.",
  server_capacity: "The server has no room for the conversion's work files right now. Retry later.",
  repository_public:
    "The repository is public (or more visible than the connection allows), and Kaiju never writes a project into it; nothing more was pushed. Make it private on the host and retry, or abandon.",
  repository_changed:
    "Someone pushed other commits to the repository while it was being written. Abandon this attempt, or reset the repository's default branch on the host and retry.",
  default_branch_mismatch:
    "The repository's default branch on the host is not the branch Kaiju pushed. Set it on the host, then retry.",
  content_missing:
    "A file of the project could not be read from Kaiju's storage. Try again later; if it keeps failing, tell your Site admin.",
  connection_unavailable:
    "The git connection was removed, is no longer at Read and write, or the Site no longer allows its host. Retry once it is back.",
  credential_rejected:
    "The git host refused the Workspace's credential. A Workspace admin should check the connection, then retry.",
  credential_forbidden:
    "The Workspace's credential is not allowed to do that on the host. A Workspace admin should check its permissions, then retry.",
  push_rejected:
    "The git host refused the push (its reason is in the detail, e.g. a size limit or a rule on the host). Retry after fixing it on the host, or abandon.",
  host_unreachable: "The git host could not be reached. Retry shortly.",
  host_rate_limited: "The git host is rate limiting Kaiju. Retry later.",
  project_changed:
    "The project changed while it was being converted. Retry to carry the new commits too.",
  internal_error: "The conversion stopped on an unexpected error. Retry, or abandon it.",
};
