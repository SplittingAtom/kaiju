import {
  GIT_ACCESS_LEVEL_VALUES,
  GIT_ACCESS_TOKEN_MAX,
  GIT_APP_PRIVATE_KEY_MAX,
  GIT_BASE_URL_MAX,
  GIT_BRANCH_NAME_MAX,
  GIT_BRANCH_NAME_PATTERN,
  GIT_CONNECTION_AGENTS_MAX,
  GIT_CREDENTIAL_KINDS_BY_PROVIDER,
  GIT_DISPLAY_NAME_MAX,
  GIT_ORGANIZATION_MAX,
  GIT_ORGANIZATION_PATTERN,
  GIT_PROVIDER_VALUES,
  GIT_PUSH_LIMIT_MAX_BYTES,
  GIT_REPO_NAME_PREFIX_MAX,
  GIT_REPO_NAME_PREFIX_PATTERN,
  GIT_REPO_VISIBILITY_VALUES,
  gitCredentialSecretSchema,
  type GitCredentialSecret,
} from "@kaiju/db";
import { z } from "zod";

/**
 * Request bodies of the connection routes (`/v1/team/git/connections`, KOBE-760; spec G1, G4-G8).
 * The credential is accepted here and nowhere else; refusals name the field, never its value.
 * The OpenAPI catalog publishes these schemas.
 */

/** A GitHub App installation (G5): App ID and installation ID in clear, the private key sealed. */
export const githubAppCredentialSchema = z.strictObject({
  kind: z.literal("github_app"),
  app_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  installation_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** PEM, as GitHub hands it out (PKCS#1 or PKCS#8, unencrypted). Write-only. */
  private_key: z.string().min(1).max(GIT_APP_PRIVATE_KEY_MAX),
});

/** An access token (G6): fine-grained (GitHub) or a bot account's (Gitea, Forgejo). Write-only. */
export const accessTokenCredentialSchema = z.strictObject({
  kind: z.literal("access_token"),
  token: z
    .string()
    .min(1)
    .max(GIT_ACCESS_TOKEN_MAX)
    .regex(/^[\x21-\x7e]+$/),
});

export const gitCredentialInputSchema = z.discriminatedUnion("kind", [
  githubAppCredentialSchema,
  accessTokenCredentialSchema,
]);
export type GitCredentialInput = z.infer<typeof gitCredentialInputSchema>;

const organization = z
  .string()
  .min(1)
  .max(GIT_ORGANIZATION_MAX)
  .regex(new RegExp(GIT_ORGANIZATION_PATTERN));
const displayName = z
  .string()
  .trim()
  .min(1)
  .max(GIT_DISPLAY_NAME_MAX)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
const defaultBranch = z
  .string()
  .min(1)
  .max(GIT_BRANCH_NAME_MAX)
  .regex(new RegExp(GIT_BRANCH_NAME_PATTERN))
  .refine((b) => !/(\.\.|\/\/|\/$|\.lock$|\.$)/.test(b), "not a valid branch name");
const agentIds = z
  .array(z.uuid())
  .min(1)
  .max(GIT_CONNECTION_AGENTS_MAX)
  .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, "duplicate id")
  .nullable();

/** The settings a Workspace admin chooses (G1 defaults, G11 push limit, GQ8 agents, GQ11). */
export const gitConnectionSettingsShape = {
  display_name: displayName,
  access_level: z.enum(GIT_ACCESS_LEVEL_VALUES),
  repo_visibility: z.enum(GIT_REPO_VISIBILITY_VALUES),
  repo_name_prefix: z
    .string()
    .max(GIT_REPO_NAME_PREFIX_MAX)
    .regex(new RegExp(GIT_REPO_NAME_PREFIX_PATTERN)),
  default_branch: defaultBranch,
  push_limit_bytes: z.number().int().min(1).max(GIT_PUSH_LIMIT_MAX_BYTES),
  direct_commits: z.boolean(),
  /** Null: every agent in the Workspace (GQ8). */
  agent_ids: agentIds,
} as const;

const target = {
  provider: z.enum(GIT_PROVIDER_VALUES),
  /** Default `https://github.com` for GitHub; required for Gitea and Forgejo. */
  base_url: z.string().min(1).max(GIT_BASE_URL_MAX).optional(),
  organization,
  credential: gitCredentialInputSchema,
};

type Targeted = {
  readonly provider: (typeof GIT_PROVIDER_VALUES)[number];
  readonly base_url?: string | undefined;
  readonly credential: GitCredentialInput;
};

function checkTarget(value: Targeted, ctx: z.RefinementCtx): void {
  if (!GIT_CREDENTIAL_KINDS_BY_PROVIDER[value.provider].includes(value.credential.kind)) {
    ctx.addIssue({
      code: "custom",
      path: ["credential", "kind"],
      message: "Gitea and Forgejo connect with an access token",
    });
  }
  if (value.provider !== "github" && value.base_url === undefined) {
    ctx.addIssue({ code: "custom", path: ["base_url"], message: "the host's address is needed" });
  }
}

/** POST /v1/team/git/connections/test: a test without saving (G4). */
export const gitConnectionTestBodySchema = z
  .strictObject({ ...target, access_level: gitConnectionSettingsShape.access_level.optional() })
  .superRefine(checkTarget);

/** POST /v1/team/git/connections: connect (tested before it is stored). */
export const gitConnectionCreateBodySchema = z
  .strictObject({
    ...target,
    display_name: displayName.optional(),
    access_level: gitConnectionSettingsShape.access_level.optional(),
    repo_visibility: gitConnectionSettingsShape.repo_visibility.optional(),
    repo_name_prefix: gitConnectionSettingsShape.repo_name_prefix.optional(),
    default_branch: gitConnectionSettingsShape.default_branch.optional(),
    push_limit_bytes: gitConnectionSettingsShape.push_limit_bytes.optional(),
    direct_commits: gitConnectionSettingsShape.direct_commits.optional(),
    agent_ids: gitConnectionSettingsShape.agent_ids.optional(),
  })
  .superRefine(checkTarget);
export type GitConnectionCreateBody = z.infer<typeof gitConnectionCreateBodySchema>;

/** PATCH /v1/team/git/connections/{id}: settings only (host, organization, credential fixed). */
export const gitConnectionUpdateBodySchema = z
  .strictObject({
    display_name: gitConnectionSettingsShape.display_name.optional(),
    access_level: gitConnectionSettingsShape.access_level.optional(),
    repo_visibility: gitConnectionSettingsShape.repo_visibility.optional(),
    repo_name_prefix: gitConnectionSettingsShape.repo_name_prefix.optional(),
    default_branch: gitConnectionSettingsShape.default_branch.optional(),
    push_limit_bytes: gitConnectionSettingsShape.push_limit_bytes.optional(),
    direct_commits: gitConnectionSettingsShape.direct_commits.optional(),
    agent_ids: gitConnectionSettingsShape.agent_ids.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "change at least one setting");
export type GitConnectionUpdateBody = z.infer<typeof gitConnectionUpdateBodySchema>;

/** PUT /v1/team/git/connections/{id}/credential: replace (tested before it is stored, G8). */
export const gitConnectionCredentialBodySchema = z.strictObject({
  credential: gitCredentialInputSchema,
});

/** The sealed shape of a credential input; undefined when the private key is not usable PEM. */
export function credentialSecretOf(input: GitCredentialInput): GitCredentialSecret | undefined {
  const parsed = gitCredentialSecretSchema.safeParse(
    input.kind === "github_app"
      ? { kind: "github_app", privateKey: input.private_key }
      : { kind: "access_token", token: input.token },
  );
  return parsed.success ? parsed.data : undefined;
}

/** The App ids of a credential input (null for a token). */
export function appIdsOf(input: GitCredentialInput): {
  readonly githubAppId: number | null;
  readonly githubInstallationId: number | null;
} {
  return input.kind === "github_app"
    ? { githubAppId: input.app_id, githubInstallationId: input.installation_id }
    : { githubAppId: null, githubInstallationId: null };
}
