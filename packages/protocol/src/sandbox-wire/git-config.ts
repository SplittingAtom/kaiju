import { z } from "zod";

/**
 * Git in the sandbox (KOBE-764, spec docs/specs/workspace-git.md G11, G13). Additive: the server
 * sends `run.start.git` only to agents whose `hello.capabilities` lists {@link CAPABILITY_GIT}.
 *
 * It carries the commit identity the agent writes into the thread's git config (G13: the member
 * as author, "via Kobe" in the committer) and the base URL and organization of each Workspace
 * connection the sandbox's git may use (G11). It carries no credential, no token and no proxy URL:
 * the agent maps `https://<host>/<organization>/` remotes to plain-HTTP ones, which go to the egress
 * proxy with the sandbox's own egress token, and the proxy adds the Workspace's credential
 * (KOBE-763). Unknown keys are stripped, so a newer server's additive field never breaks an agent.
 */
export const CAPABILITY_GIT = "git";

/** As `GIT_CONNECTIONS_MAX` in @kobe/db: a Workspace has at most five connections (G2). */
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
 * A connection's base URL as stored (`parseGitBaseUrl` in @kobe/db): https, lowercase host, an
 * optional sub-path (Gitea/Forgejo installed under a path), no trailing slash, no query. No port:
 * the egress proxy carries git only to https on 443 (KOBE-763), so the server leaves such
 * connections out.
 */
const baseUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/, "canonical https base URL");

/** As `GIT_ORGANIZATION_PATTERN` / `GIT_ORGANIZATION_MAX` in @kobe/db. */
const organization = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const runGitRemoteSchema = z.object({ base_url: baseUrl, organization });
export type RunGitRemote = z.infer<typeof runGitRemoteSchema>;

export const runGitContextSchema = z.object({
  /** The member (G13): their name and their Kobe email, or the Workspace's no-reply form (GQ10). */
  author: gitIdentitySchema,
  /** The member's name with "via Kobe", and the author's email. */
  committer: gitIdentitySchema,
  /** The connected organizations the sandbox's git may reach through the egress proxy. */
  remotes: z.array(runGitRemoteSchema).max(RUN_GIT_REMOTES_MAX),
});
export type RunGitContext = z.infer<typeof runGitContextSchema>;
