import { z } from "zod";
import { PROJECT_SLUG_MAX } from "../projects.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Git in the sandbox (KOBE-764, spec docs/specs/workspace-git.md G11, G13). Additive: the server
 * sends `run.start.git` only to agents whose `hello.capabilities` lists {@link CAPABILITY_GIT}.
 *
 * It carries the commit identity the agent writes into the thread's git config (G13: the member
 * as author, "via Kaiju" in the committer) and the base URL and organization of each Workspace
 * connection the sandbox's git may use (G11). It carries no credential, no token and no proxy URL:
 * the agent maps `https://<host>/<organization>/` remotes to plain-HTTP ones, which go to the egress
 * proxy with the sandbox's own egress token, and the proxy adds the Workspace's credential
 * (KOBE-763). Unknown keys are stripped, so a newer server's additive field never breaks an agent.
 */
export const CAPABILITY_GIT = "git";

/** As `GIT_CONNECTIONS_MAX` in @kaiju/db: a Workspace has at most five connections (G2). */
export const RUN_GIT_REMOTES_MAX = 5;
export const GIT_IDENTITY_NAME_MAX = 200;
export const GIT_IDENTITY_EMAIL_MAX = 254;

/**
 * A name git writes into a commit header and the agent writes into a config file: no angle
 * brackets (git's header delimiters), quotes, backslashes or control characters, no surrounding
 * spaces.
 */
const identityName = z
  .string()
  .min(1)
  .max(GIT_IDENTITY_NAME_MAX)
  .regex(/^[^<>"\\\p{Cc}]+$/u, "no angle brackets, quotes, backslashes or control characters")
  .refine((s) => s.trim() === s, "no surrounding spaces");

/** One address, `local@domain`, with nothing git or a config file would misread. */
const identityEmail = z
  .string()
  .min(3)
  .max(GIT_IDENTITY_EMAIL_MAX)
  .regex(/^[^\s<>"\\@\p{Cc}]+@[^\s<>"\\@\p{Cc}]+$/u, "local@domain");

export const gitIdentitySchema = z.strictObject({ name: identityName, email: identityEmail });
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

/**
 * A connection's base URL as stored (`parseGitBaseUrl` in @kaiju/db): https, lowercase host, an
 * optional sub-path (Gitea/Forgejo installed under a path), no trailing slash, no query. No port:
 * the egress proxy carries git only to https on 443 (KOBE-763), so the server leaves such
 * connections out.
 */
const baseUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/, "canonical https base URL");

/** As `GIT_ORGANIZATION_PATTERN` / `GIT_ORGANIZATION_MAX` in @kaiju/db. */
const organization = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const runGitRemoteSchema = z.object({ base_url: baseUrl, organization });
export type RunGitRemote = z.infer<typeof runGitRemoteSchema>;

/**
 * `.kaiju/repos/<slug>`: where a conversation's Repo is checked out as a git working copy (KOBE-767).
 * Under the workspace's reserved `.kaiju/` area (`WORKSPACE_EXCLUDED_PREFIXES`), which the sync never
 * pushes, pulls or restores and the server never stores, so it can never collide with a member's
 * own files (review N2): a My files folder named `repos/` stays an ordinary synced folder.
 */
export const REPO_WORKING_COPY_DIR = ".kaiju/repos";
const slug = z
  .string()
  .max(PROJECT_SLUG_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
/** `refs/heads/<name>` names Kaiju sends or reads back (no `..`, no leading `-`, at most 255). */
const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s:~^?*[\\]+$/)
  .refine((b) => !b.includes("..") && !b.startsWith("-") && !b.endsWith(".lock"), "branch name");
const commitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * The conversation's Repo (KOBE-767, spec workspace-git G18, G19): the agent keeps a real git
 * working copy of it at `/workspace/.kaiju/repos/<slug>`, cloned through the egress proxy like any
 * repository of a connected organization (G11; the clone URL is the host's ordinary https URL,
 * which the tools' git config routes to the proxy). Sent only when the thread is in a Repo whose
 * connection is among `remotes` and the member may converse in the project. `access`: whether the
 * member may push there (the proxy decides every push all the same, KOBE-763).
 */
export const runGitRepoSchema = z.object({
  project_id: z.uuid(),
  slug,
  /** `https://<host>[/<base>]/<organization>/<repository>.git`. */
  clone_url: z
    .string()
    .max(2048)
    .regex(
      /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/[A-Za-z0-9._-]{1,100}\.git$/,
      "https clone URL",
    ),
  default_branch: branchName,
  access: z.enum(["read", "write"]),
});
export type RunGitRepo = z.infer<typeof runGitRepoSchema>;

export const runGitContextSchema = z.object({
  /** The member (G13): their name and their Kaiju email, or the Workspace's no-reply form (GQ10). */
  author: gitIdentitySchema,
  /** The member's name with "via Kaiju", and the author's email. */
  committer: gitIdentitySchema,
  /** The connected organizations the sandbox's git may reach through the egress proxy. */
  remotes: z.array(runGitRemoteSchema).max(RUN_GIT_REMOTES_MAX),
  /** The thread's Repo as a git working copy (KOBE-767); absent outside a Repo or from older servers. */
  repo: runGitRepoSchema.optional(),
});
export type RunGitContext = z.infer<typeof runGitContextSchema>;

function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/** Most bytes of the short reason a working copy could not be prepared or fetched. */
export const REPO_STATUS_PROBLEM_MAX = 200;

/**
 * Sandbox -> server (KOBE-767, G19): the state of the thread's Repo working copy, after the agent
 * prepared or fetched it at run start and again when the run ended. Sent only for a
 * `run.start.git.repo` the server gave (an older server never gets it). `branch` null: detached
 * HEAD; `upstream` null: the branch tracks nothing on the host (ahead/behind then count against
 * the default branch on the host, `origin/<default>`). Counts are capped at 10,000. `fetched`:
 * false when the last fetch failed, so `behind` may be stale. Never answered; malformed or
 * foreign ones are dropped. No file names, no content.
 */
export const repoStatusFrameSchema = frame("repo.status", {
  run_id: z.uuid(),
  thread_id: z.uuid(),
  project_id: z.uuid(),
  branch: branchName.nullable(),
  head_sha: commitSha.nullable(),
  upstream: branchName.nullable(),
  ahead: z.number().int().min(0).max(10_000),
  behind: z.number().int().min(0).max(10_000),
  dirty: z.boolean(),
  fetched: z.boolean(),
  problem: z.string().max(REPO_STATUS_PROBLEM_MAX).nullable(),
});
export type RepoStatusFrame = z.infer<typeof repoStatusFrameSchema>;
