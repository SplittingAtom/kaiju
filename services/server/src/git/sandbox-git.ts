import {
  eq,
  readGitConnections,
  sql,
  users,
  withTeam,
  type GitConnectionRecord,
  type KobeDb,
} from "@kobe/db";
import {
  GIT_IDENTITY_NAME_MAX,
  gitIdentitySchema,
  RUN_GIT_REMOTES_MAX,
  runGitRemoteSchema,
  type RunGitContext,
  type RunGitRemote,
} from "@kobe/protocol/sandbox-wire";
import { reachableBase } from "./transport.js";

/**
 * `run.start.git` (KOBE-764, spec docs/specs/workspace-git.md G11, G13, GQ10): what the sandbox
 * agent writes into the tools' git config for a member's run. No credential and no token: only
 * the commit identity and the base URL and organization of each connection the sandbox's git may
 * use through the egress proxy (which decides every request, KOBE-763).
 *
 * Authorship (G13): the member's name and their Kobe email as author, "<name> via Kobe" with the
 * same email as committer. A Workspace setting (GQ10, `teams.settings.git_commit_email`) switches
 * the email to a no-reply form under the Site's own host, `<user id>@users.noreply.<host>`: stable
 * per member, never a real mailbox, and no domain other than the Site's.
 */

/** The `teams.settings` key of the commit email choice (no migration: `teams.settings` is jsonb). */
export const TEAM_GIT_COMMIT_EMAIL_SETTING = "git_commit_email";
export const GIT_COMMIT_EMAIL_MODES = ["member", "noreply"] as const;
export type GitCommitEmailMode = (typeof GIT_COMMIT_EMAIL_MODES)[number];

/** What "via Kobe" says in the committer (G13). */
export const GIT_COMMITTER_SUFFIX = " via Kobe";
const FALLBACK_NAME = "Kobe member";

/** The Workspace's choice from `teams.settings`; anything but `noreply` is the member's email. */
export function gitCommitEmailMode(settings: unknown): GitCommitEmailMode {
  const value =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>)[TEAM_GIT_COMMIT_EMAIL_SETTING]
      : undefined;
  return value === "noreply" ? "noreply" : "member";
}

/** The no-reply address of a member under the Site's host (GQ10). */
export function gitNoReplyEmail(userId: string, siteHost: string): string {
  return `${userId.toLowerCase()}@users.noreply.${siteHost.toLowerCase()}`;
}

/** A name git and a config file read as one value: no `<>"\`, no controls, one line, capped. */
export function gitAuthorName(name: string, max = GIT_IDENTITY_NAME_MAX): string {
  const clean = name
    .replace(/[<>"\\\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max)
    .trim();
  return clean === "" ? FALLBACK_NAME : clean;
}

/** The connections the sandbox's git may use: on, not limited to chosen agents, https on 443. */
export function gitRemotesOf(connections: readonly GitConnectionRecord[]): RunGitRemote[] {
  const out: RunGitRemote[] = [];
  const seen = new Set<string>();
  for (const c of connections) {
    // Agent-limited connections are refused for transport (KOBE-763: one sandbox serves all of a
    // member's agents), so the sandbox is not pointed at them.
    if (c.accessLevel === "off" || c.agentIds !== null) continue;
    const base = reachableBase(c.baseUrl);
    if (base === undefined) continue;
    const parsed = runGitRemoteSchema.safeParse({
      base_url: `https://${base.host}${base.path}`,
      organization: c.organization,
    });
    if (!parsed.success) continue;
    const key = `${parsed.data.base_url}/${parsed.data.organization.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length === RUN_GIT_REMOTES_MAX) break;
  }
  return out;
}

export interface RunGitInput {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly mode: GitCommitEmailMode;
  /** The Site's host (`KOBE_PUBLIC_URL`), for the no-reply form. */
  readonly siteHost: string;
  readonly connections: readonly GitConnectionRecord[];
}

/** The run's git context (pure). */
export function buildRunGitContext(input: RunGitInput): RunGitContext {
  const { user } = input;
  const noReply = gitNoReplyEmail(user.id, input.siteHost);
  const own = user.email.trim();
  // An address git or the config file would misread falls back to the no-reply form.
  const email =
    input.mode === "member" && gitIdentitySchema.shape.email.safeParse(own).success ? own : noReply;
  const name = gitAuthorName(user.name, GIT_IDENTITY_NAME_MAX - GIT_COMMITTER_SUFFIX.length);
  return {
    author: { name, email },
    committer: { name: `${name}${GIT_COMMITTER_SUFFIX}`, email },
    remotes: gitRemotesOf(input.connections),
  };
}

/** The member's run git context, or undefined when the member is not found. */
export async function loadRunGitContext(
  db: KobeDb,
  target: { readonly teamId: string; readonly userId: string },
  siteHost: string,
): Promise<RunGitContext | undefined> {
  const { teamId, userId } = target;
  return withTeam(db, teamId, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return undefined;
    const team = await tx.execute<{ settings: unknown }>(
      sql`SELECT settings FROM teams WHERE id = ${teamId}`,
    );
    const connections = await readGitConnections(tx, teamId);
    return buildRunGitContext({
      user,
      mode: gitCommitEmailMode(team.rows[0]?.settings),
      siteHost,
      connections,
    });
  });
}
