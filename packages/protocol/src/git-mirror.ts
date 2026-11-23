import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { GIT_CONNECTION_PROVIDERS } from "./git-connections.js";

/**
 * The Repo mirror (KOBE-766, spec workspace-git G17, G20): the answers and bodies of
 * `/v1/projects/{id}/repo*`, shared by the server and the Files panel (KOBE-768). After Convert
 * to repo the host's default branch is the record; Kobe keeps a mirror of it (files and the
 * newest commits), refreshed when Kobe pushes, when the Repo is opened, on a timer and on
 * Refresh. When the repository is deleted or archived on the host, or its connection was removed,
 * the Repo is read-only from its last mirror and a Workspace admin may relink or detach it. No
 * shape here carries a credential.
 */

/** The repository on the host as Kobe last saw it (repeats `@kobe/db`'s host states). */
export const GIT_REPO_HOST_STATES = ["active", "archived", "deleted", "unreachable"] as const;
export type GitRepoHostState = (typeof GIT_REPO_HOST_STATES)[number];

/** Why a Repo is read-only (the banner): null while the host repository is there. */
export const GIT_REPO_READ_ONLY_REASONS = ["archived", "deleted", "connection_removed"] as const;
export type GitRepoReadOnlyReason = (typeof GIT_REPO_READ_ONLY_REASONS)[number];

/** Why the last refresh failed (the mirror stays as it was; the server retries later). */
export const GIT_MIRROR_FAILURES = [
  "connection_off",
  "host_not_allowed",
  "credential_unavailable",
  "credential_rejected",
  "credential_forbidden",
  /** The connection's hourly read budget (shared with agents' git tools) is used up. */
  "connection_budget",
  "host_rate_limited",
  "host_unreachable",
  /** The default branch is not on the host. */
  "branch_missing",
  /** More files than a Kobe project holds. */
  "too_many_files",
  /** A file larger than a Kobe project file may be. */
  "file_too_large",
  "repository_too_large",
  /** A path Kobe's projects cannot hold. */
  "unsupported_path",
  "fetch_failed",
  "server_capacity",
  /** A legal hold covers the Workspace and the refresh would remove files. */
  "legal_hold",
  "git_unavailable",
  /**
   * The host answered "not found" for the repository: deleted, moved out of the organization, or
   * no longer visible to the credential. Marked `deleted` only after several answers in a row.
   */
  "repository_not_found",
  /** The previous refresh stopped before it finished (the server restarted or ran out of room). */
  "interrupted",
  "internal_error",
] as const;
export type GitMirrorFailure = (typeof GIT_MIRROR_FAILURES)[number];

/** One commit of the mirrored branch, newest first (host text, shown as plain text). */
export const gitRepoCommitSchema = z.strictObject({
  sha: z.string(),
  author_name: z.string(),
  authored_at: timestampSchema,
  /** The first line of the message. */
  message: z.string(),
});
export type GitRepoCommit = z.infer<typeof gitRepoCommitSchema>;

export const gitRepoMirrorSchema = z.strictObject({
  /** The host commit the mirrored files are. */
  head_sha: z.string().nullable(),
  /** The last successful refresh (the panel's "last refreshed"). */
  refreshed_at: timestampSchema.nullable(),
  /** The last attempt, successful or not. */
  attempted_at: timestampSchema.nullable(),
  /** A refresh is running now. */
  refreshing: z.boolean(),
  /** After failures: not retried by the timer before this time (Refresh still may). */
  next_attempt_at: timestampSchema.nullable(),
  failures: z.number().int().nonnegative(),
  error: z.strictObject({ code: z.enum(GIT_MIRROR_FAILURES), message: z.string() }).nullable(),
  /**
   * The repository grew past what a mirror can hold (500 files, 50 MiB per file, 512 MiB in all):
   * the panel shows the last mirror, plainly marked as such, until the repository shrinks.
   */
  too_large: z.boolean(),
});
export type GitRepoMirror = z.infer<typeof gitRepoMirrorSchema>;

/** A project that is a Repo: its repository, mirror and newest commits. */
export const gitRepoViewSchema = z.strictObject({
  project_id: uuidSchema,
  repository_id: uuidSchema,
  /** Null once the connection was removed. */
  connection_id: uuidSchema.nullable(),
  provider: z.enum(GIT_CONNECTION_PROVIDERS).nullable(),
  base_url: z.string(),
  /** `organization/repository` as last seen (renames and transfers are followed by the host's id). */
  full_name: z.string(),
  /** The repository's page on the host. */
  web_url: z.string(),
  default_branch: z.string(),
  host_state: z.enum(GIT_REPO_HOST_STATES),
  read_only: z.boolean(),
  read_only_reason: z.enum(GIT_REPO_READ_ONLY_REASONS).nullable(),
  /** The caller may relink or detach it (Workspace admins). */
  can_manage: z.boolean(),
  mirror: gitRepoMirrorSchema,
  commits: z.array(gitRepoCommitSchema),
});
export type GitRepoView = z.infer<typeof gitRepoViewSchema>;

/** `GET /v1/projects/{id}/repo`, Refresh and Relink. */
export const gitRepoAnswerSchema = z.strictObject({ repo: gitRepoViewSchema });
export type GitRepoAnswer = z.infer<typeof gitRepoAnswerSchema>;

/** `POST /v1/projects/{id}/repo/relink`: another repository (by name) of a connected organization. */
export const gitRepoRelinkBodySchema = z.strictObject({
  connection_id: uuidSchema,
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});
export type GitRepoRelinkBody = z.infer<typeof gitRepoRelinkBodySchema>;

/** `POST /v1/projects/{id}/repo/detach`: the project is an ordinary project again. */
export const gitRepoDetachedSchema = z.strictObject({
  project_id: uuidSchema,
  /** The Kobe commit of the mirrored files that starts its own history again. */
  commit_id: uuidSchema,
  seq: z.number().int().positive(),
});
export type GitRepoDetached = z.infer<typeof gitRepoDetachedSchema>;
