import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";

/**
 * Workspace git connections (KOBE-760, spec workspace-git §3, §4, §7): the answers of
 * `/v1/team/git/connections*`, shared by the server and the Git section of the Workspace admin
 * console (KOBE-761). No shape here can carry a credential: a token appears only as its masked
 * hint, a GitHub App only as its App ID and installation ID. The value lists repeat `@kobe/db`'s
 * (`GIT_PROVIDER_VALUES` and friends; a server test keeps them equal).
 */

export const GIT_CONNECTION_PROVIDERS = ["github", "gitea", "forgejo"] as const;
export const GIT_CONNECTION_CREDENTIAL_KINDS = ["github_app", "access_token"] as const;
export const GIT_CONNECTION_ACCESS_LEVELS = ["off", "read", "read_write"] as const;
export const GIT_CONNECTION_REPO_VISIBILITIES = ["private", "internal"] as const;
export const GIT_CONNECTION_CAPABILITY_VALUES = ["yes", "no", "unknown"] as const;
/** `not_allowed`: the Site turned Git off or no longer allows the host (G3); nothing is sent. */
export const GIT_CONNECTION_HEALTH = ["ok", "failing", "unchecked", "not_allowed"] as const;

const provider = z.enum(GIT_CONNECTION_PROVIDERS);
const accessLevel = z.enum(GIT_CONNECTION_ACCESS_LEVELS);
const capability = z.enum(GIT_CONNECTION_CAPABILITY_VALUES);
const capabilityName = z.enum(["create", "read", "write", "admin"]);

/** What the credential may do in the organization (G4), as the last test found it. */
export const gitCapabilitiesViewSchema = z.strictObject({
  create: capability,
  read: capability,
  write: capability,
  admin: capability,
});

/** A connection as a Workspace admin sees it (`team.git.manage`). */
export const gitConnectionAdminViewSchema = z.strictObject({
  id: uuidSchema,
  provider,
  base_url: z.string(),
  organization: z.string(),
  display_name: z.string(),
  access_level: accessLevel,
  credential: z.strictObject({
    kind: z.enum(GIT_CONNECTION_CREDENTIAL_KINDS),
    /** The token's last characters, masked (`••••abcd`); null for a GitHub App. */
    hint: z.string().nullable(),
    github_app_id: z.number().int().nullable(),
    github_installation_id: z.number().int().nullable(),
    updated_at: timestampSchema,
    /** When the host reports one (G6); the console warns 14 days ahead (`expires_soon`). */
    expires_at: timestampSchema.nullable(),
    expires_soon: z.boolean(),
  }),
  repo_defaults: z.strictObject({
    visibility: z.enum(GIT_CONNECTION_REPO_VISIBILITIES),
    name_prefix: z.string(),
    default_branch: z.string(),
  }),
  push_limit_bytes: z.number().int().positive(),
  direct_commits: z.boolean(),
  /** Null: every agent in the Workspace (GQ8). */
  agent_ids: z.array(uuidSchema).nullable(),
  capabilities: gitCapabilitiesViewSchema,
  /** Permissions beyond what the connection needs, by the host's names (G4). */
  excess_permissions: z.array(z.string()),
  health: z.strictObject({
    status: z.enum(GIT_CONNECTION_HEALTH),
    last_checked_at: timestampSchema.nullable(),
    last_ok_at: timestampSchema.nullable(),
    /** A machine code such as `auth_failed:credential_rejected`; never the host's message. */
    last_error: z.string().nullable(),
  }),
  created_by: uuidSchema,
  updated_by: uuidSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type GitConnectionAdminView = z.infer<typeof gitConnectionAdminViewSchema>;

/** A connection as every other member sees it (§7: what their agents can reach). */
export const gitConnectionMemberViewSchema = z.strictObject({
  id: uuidSchema,
  provider,
  base_url: z.string(),
  organization: z.string(),
  display_name: z.string(),
  access_level: accessLevel,
  status: z.enum(GIT_CONNECTION_HEALTH),
  /**
   * KOBE-768: the prefix new repositories' names get (the Convert to repo dialog shows the name
   * with it, G16). Absent on older answers.
   */
  repo_name_prefix: z.string().optional(),
});
export type GitConnectionMemberView = z.infer<typeof gitConnectionMemberViewSchema>;

/** `GET /v1/team/git/connections`. `allowed_hosts` only for Workspace admins. */
export const gitConnectionListSchema = z.strictObject({
  connections: z.array(z.union([gitConnectionAdminViewSchema, gitConnectionMemberViewSchema])),
  site: z.strictObject({
    enabled: z.boolean(),
    allowed_hosts: z.array(z.string()).optional(),
  }),
  limit: z.number().int().positive(),
  /** False: the site has no envelope key, so nothing can be connected (503 `git_unavailable`). */
  envelope_configured: z.boolean(),
});
export type GitConnectionList = z.infer<typeof gitConnectionListSchema>;

/** A warning shown with a passing test (G4). */
export const gitTestWarningSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("excess_permissions"), permissions: z.array(z.string()) }),
  z.strictObject({ code: z.literal("more_than_level"), capabilities: z.array(capabilityName) }),
  z.strictObject({ code: z.literal("unverified"), capabilities: z.array(capabilityName) }),
]);

/** What a connection test found (G4). `ok` false: `missing` names what the level needs. */
export const gitTestReportSchema = z.strictObject({
  ok: z.boolean(),
  /** The product the host identifies as (a Forgejo picked as Gitea reads `forgejo`). */
  provider,
  organization: z.strictObject({
    login: z.string(),
    name: z.string().nullable(),
    kind: z.enum(["organization", "user"]),
  }),
  host_version: z.string().nullable(),
  /** Who actions appear as on the host: the App's bot or the token's owner (G5, G6). */
  actor: z.strictObject({ kind: z.enum(["app", "token"]), login: z.string().nullable() }),
  capabilities: gitCapabilitiesViewSchema,
  excess_permissions: z.array(z.string()),
  credential_expires_at: timestampSchema.nullable(),
  missing: z.array(capabilityName),
  warnings: z.array(gitTestWarningSchema),
});
export type GitTestReport = z.infer<typeof gitTestReportSchema>;

/** A failed test's error envelope: fixed text and the adapter's codes, never the host's answer. */
export const gitTestErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  test: z.strictObject({
    code: z.string(),
    reason: z.string().optional(),
    missing_permission: z.string().optional(),
    retry_at: timestampSchema.optional(),
  }),
});
export type GitTestError = z.infer<typeof gitTestErrorSchema>;

/** `POST /v1/team/git/connections/test`. */
export const gitConnectionTestAnswerSchema = z.strictObject({ test: gitTestReportSchema });

/** `POST /v1/team/git/connections` (201) and `PUT .../{id}/credential` (200). */
export const gitConnectionSavedSchema = z.strictObject({
  connection: gitConnectionAdminViewSchema,
  test: gitTestReportSchema,
});

/** `GET .../{id}` and `PATCH .../{id}`. */
export const gitConnectionOneSchema = z.strictObject({
  connection: z.union([gitConnectionAdminViewSchema, gitConnectionMemberViewSchema]),
});

/** `POST .../{id}/check`: the stored health, with the test or the error. */
export const gitConnectionCheckedSchema = z.strictObject({
  connection: gitConnectionAdminViewSchema,
  test: gitTestReportSchema.nullable(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      test: gitTestErrorSchema.shape.test.optional(),
    })
    .nullable(),
});

/** `DELETE .../{id}`: the repository records kept without a connection (G20). */
export const gitConnectionRemovedSchema = z.strictObject({
  id: uuidSchema,
  repositories_kept: z.number().int().nonnegative(),
});

/** How commits made in sandboxes name their author (G13, GQ10; KOBE-764's reader). */
export const GIT_COMMIT_EMAIL_MODES = ["member", "noreply"] as const;
export type GitCommitEmailMode = (typeof GIT_COMMIT_EMAIL_MODES)[number];

/**
 * `GET` / `PATCH /v1/team/git/settings` (Workspace admins): the Workspace's git settings.
 * `noreply_example` is the caller's own no-reply address, to show what the choice writes.
 */
export const gitTeamSettingsSchema = z.strictObject({
  commit_email: z.enum(GIT_COMMIT_EMAIL_MODES),
  noreply_example: z.string(),
});
export type GitTeamSettings = z.infer<typeof gitTeamSettingsSchema>;
