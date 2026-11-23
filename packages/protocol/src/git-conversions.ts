import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { GIT_CONNECTION_PROVIDERS, GIT_CONNECTION_REPO_VISIBILITIES } from "./git-connections.js";

/**
 * Convert to repo (KOBE-765, spec workspace-git G15-G17, GQ12, GQ13): the body and answers of
 * `/v1/projects/{id}/repo-conversion*`, shared by the server and the Convert to repo dialog
 * (KOBE-768). A conversion creates a private (or internal) repository in a connected organization,
 * writes the project's commits into it as git commits (or one commit of the current files), then
 * marks the project a Repo. It runs as a resumable job: the start answers 202 and the dialog reads
 * the attempt until it is `completed` or `failed`. No shape here carries a credential.
 */

/** The status values repeat `@kobe/db`'s `GIT_CONVERSION_STATUS_VALUES` (a server test keeps them equal). */
export const GIT_CONVERSION_STATUSES = ["running", "failed", "completed", "abandoned"] as const;
export const GIT_CONVERSION_STEPS = ["create", "push", "finish", "done"] as const;

/**
 * Why a step failed (the attempt is `failed`, a person may retry or abandon it). The server's
 * `message` says the same in words; `detail` names the file or commit where one is to blame.
 */
export const GIT_CONVERSION_FAILURES = [
  /** A repository with that name exists and is not the one this attempt created. */
  "repository_exists",
  /** The chosen existing repository (or the one found after an interruption) is not empty. */
  "repository_not_empty",
  /** The repository (created for this attempt, or chosen) is not on the host (deleted, transferred). */
  "repository_gone",
  /**
   * The repository is public (or internal where the connection allows only private), checked
   * before every push: Kobe never writes a project into one (G10). Nothing more is pushed.
   */
  "repository_public",
  /** The chosen existing repository carries another Kobe conversion's mark (it may be another Workspace's Repo). */
  "repository_in_use",
  /** Someone pushed something else to the repository's default branch meanwhile. */
  "repository_changed",
  /** The host's default branch is not the one Kobe pushed. */
  "default_branch_mismatch",
  /** A saved file of the project could not be read from Kobe's storage. */
  "content_missing",
  /** A file the host's fsck refuses (found while building, before anything was created). */
  "file_rejected_by_host",
  /** The connection was removed, turned down from Read and write, or the Site no longer allows it. */
  "connection_unavailable",
  "credential_rejected",
  "credential_forbidden",
  "push_rejected",
  "host_unreachable",
  "host_rate_limited",
  "project_changed",
  /** The attempt stopped its server more than once without progress (a person must retry it). */
  "interrupted",
  /** The server has no room for the conversion's work files now. */
  "server_capacity",
  "internal_error",
] as const;
export type GitConversionFailure = (typeof GIT_CONVERSION_FAILURES)[number];

/**
 * Refusals of the start (`POST /v1/projects/{id}/repo-conversion`), each with its own status and
 * a message naming the reason (G16: "the dialog says which").
 */
export const GIT_CONVERSION_REFUSALS = [
  "already_repo",
  "conversion_in_progress",
  "archived",
  "legal_hold",
  "unsaved_checkouts",
  "connection_not_found",
  "connection_read_only",
  "cannot_create_repositories",
  "git_disabled",
  "host_not_allowed",
  "internal_not_offered",
  "invalid_repository_name",
  /** Only Workspace admins may choose an existing repository (G16). */
  "existing_repository_admin_only",
  "file_rejected_by_host",
  "project_too_large",
  /** A file is larger than git hosts accept (100 MiB, GitHub's hard limit). */
  "file_too_large",
  /**
   * KOBE-766 review R3-M1: the project's current files are more than a Repo's mirror can hold
   * (500 files, 50 MiB each, 256 MiB in all), so Kobe could never show the host's changes.
   */
  "too_large_to_mirror",
  "git_unavailable",
] as const;
export type GitConversionRefusal = (typeof GIT_CONVERSION_REFUSALS)[number];

/** `POST /v1/projects/{id}/repo-conversion`. */
export const gitConversionStartBodySchema = z.strictObject({
  connection_id: uuidSchema,
  /** Default: the connection's name prefix + the project's slug (G16). */
  repository_name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .optional(),
  /** Default: the connection's repository default (G10: never public). */
  visibility: z.enum(GIT_CONNECTION_REPO_VISIBILITIES).optional(),
  /** GQ12: carry the project's commits (default) or write one commit of the current files. */
  carry_history: z.boolean().optional(),
  /** G16: push into this existing, empty repository instead of creating one. */
  use_existing: z.boolean().optional(),
});
export type GitConversionStartBody = z.infer<typeof gitConversionStartBodySchema>;

/** One conversion attempt of a project. */
export const gitConversionViewSchema = z.strictObject({
  id: uuidSchema,
  project_id: uuidSchema,
  status: z.enum(GIT_CONVERSION_STATUSES),
  step: z.enum(GIT_CONVERSION_STEPS),
  /** Null once the connection was removed. */
  connection_id: uuidSchema.nullable(),
  provider: z.enum(GIT_CONNECTION_PROVIDERS),
  base_url: z.string(),
  organization: z.string(),
  repository_name: z.string(),
  /** `organization/repository`. */
  full_name: z.string(),
  visibility: z.enum(GIT_CONNECTION_REPO_VISIBILITIES),
  carry_history: z.boolean(),
  use_existing: z.boolean(),
  default_branch: z.string(),
  /** True once the host created the repository for this attempt (abandoning leaves it there). */
  repository_created: z.boolean(),
  commits_total: z.number().int().nonnegative().nullable(),
  commits_pushed: z.number().int().nonnegative(),
  head_sha: z.string().nullable(),
  error: z
    .strictObject({
      code: z.enum(GIT_CONVERSION_FAILURES),
      message: z.string(),
      detail: z.string().nullable(),
    })
    .nullable(),
  attempts: z.number().int().nonnegative(),
  requested_by: uuidSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  finished_at: timestampSchema.nullable(),
});
export type GitConversionView = z.infer<typeof gitConversionViewSchema>;

/** `GET /v1/projects/{id}/repo-conversion`: the latest attempt, or null. */
export const gitConversionAnswerSchema = z.strictObject({
  conversion: gitConversionViewSchema.nullable(),
});
export type GitConversionAnswer = z.infer<typeof gitConversionAnswerSchema>;

/** The start and Retry: the attempt as it runs (202). */
export const gitConversionStartedSchema = z.strictObject({ conversion: gitConversionViewSchema });

/**
 * Abandon: the attempt and, when the host created a repository for it, that repository, which
 * Kobe leaves on the host for a Workspace admin to delete or reuse (it is listed in the Git
 * section's repositories).
 */
export const gitConversionAbandonedSchema = z.strictObject({
  conversion: gitConversionViewSchema,
  left_on_host: z.strictObject({ full_name: z.string(), base_url: z.string() }).nullable(),
});
export type GitConversionAbandoned = z.infer<typeof gitConversionAbandonedSchema>;

/** A refused start: a code, a message naming the reason, and the facts the dialog shows. */
export const gitConversionRefusalSchema = z.strictObject({
  code: z.enum(GIT_CONVERSION_REFUSALS),
  message: z.string(),
  /** `file_rejected_by_host` / `file_too_large`: the first file. */
  path: z.string().optional(),
  /** `file_rejected_by_host` / `file_too_large`: every offending path (up to 20) and the first commit that has it. */
  paths: z
    .array(z.strictObject({ path: z.string(), seq: z.number().int().positive().nullable() }))
    .max(20)
    .optional(),
  seq: z.number().int().positive().optional(),
  /** `unsaved_checkouts`: how many working copies hold changes. */
  checkouts: z.number().int().positive().optional(),
  /** `project_too_large` / `file_too_large` / `too_large_to_mirror`: the limit in bytes (and the project's size). */
  limit_bytes: z.number().int().positive().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  conversion: gitConversionViewSchema.optional(),
});
