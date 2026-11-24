import {
  and,
  eq,
  gitRepositories,
  openGitCredential,
  projectMembers,
  readGitConnectionSealedCredential,
  readGitConnections,
  readGitSiteSettings,
  sql,
  teamMembers,
  withTeam,
  type Envelope,
  type GitConnectionRecord,
  type KobeDb,
  type TeamRole,
} from "@kobe/db";
import { projectPermissions } from "@kobe/protocol";
import { GitHostError, type GitHostAdapter } from "../git-hosts/adapter.js";
import { gitHostAdapter, type GitAdapterInput } from "../git-hosts/factory.js";
import type { GitHostNet } from "../git-hosts/http.js";
import { gitHostTarget } from "../git-hosts/target.js";
import { logger } from "../logger.js";
import { requestPushRefresh } from "./mirror/store.js";

/**
 * The server's decision for one git smart-HTTP request from a sandbox (spec workspace-git G11,
 * G12, §9; KOBE-763), asked by the egress proxy, which enforces it. The server
 *
 * 1. finds the Workspace's connection for the request's host and base path (exact host and path
 *    of the connection's base URL, https on 443: the proxy only reaches hosts there) and its
 *    organization (case-insensitive, as GitHub, Gitea and Forgejo treat owner names). A host and
 *    path with no connection is `no_connection` (the proxy treats the request as ordinary
 *    egress, without a credential); another organization on a connected host is refused;
 * 2. decides read or write: fetch needs the connection at Read or above; push (receive-pack)
 *    needs Read and write, the member's Workspace role Contributor or above, and for a Repo
 *    (a `git_repositories` row with a project) editor or owner of that project (G12). A schedule's
 *    run uses its owner's sandbox, so the owner's rights apply. A connection limited to chosen
 *    agents (GQ8) is refused: a sandbox serves every agent of its member, so the transport cannot
 *    tell which agent asks (see the ticket ledger). Skill-eval sandboxes never get it;
 * 3. checks the Site's git decision for the base URL (`gitHostTarget`, G3), opens the sealed
 *    credential for this one call and asks the provider adapter for a per-repository credential:
 *    a GitHub App installation token narrowed to the repository and to read or write, or the
 *    connection's token (`narrowed: false`, after the adapter confirmed the repository is in the
 *    organization and the token may read or write it).
 *
 * The credential goes back to the proxy only (internal listener); it is never logged or audited.
 */
export type GitService = "git-upload-pack" | "git-receive-pack";

export interface GitTransportRequest {
  readonly host: string;
  /** The base path before `/<owner>`: "" or `/a/b`. */
  readonly prefix: string;
  readonly owner: string;
  readonly repository: string;
  readonly service: GitService;
}

export interface GitTransportPrincipal {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly evalThreadId?: string;
}

export type GitTransportDenyCode =
  | "no_connection"
  | "outside_organization"
  | "connection_off"
  | "read_only"
  | "role_reader"
  | "project_reader"
  | "agents_restricted"
  | "eval_sandbox"
  | "site_refused"
  | "repository_unavailable"
  | "credential_forbidden"
  | "credential_rejected"
  | "credential_unavailable"
  | "host_unavailable"
  | "host_rate_limited";

export type GitTransportAnswer =
  | {
      readonly decision: "allow";
      readonly connection_id: string;
      readonly base_path: string;
      readonly organization: string;
      readonly repository: string;
      readonly access: "read" | "write";
      readonly username: string;
      readonly password: string;
      readonly expires_at: string | null;
      readonly narrowed: boolean;
      readonly push_limit_bytes: number;
    }
  | {
      readonly decision: "deny";
      readonly code: GitTransportDenyCode;
      readonly message: string;
    };

export interface GitTransportDeps {
  readonly db: KobeDb;
  /** Opens the sealed credential; unset (no envelope key): every request is refused. */
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  /** Tests: a fake adapter. */
  readonly adapterFor?: (input: GitAdapterInput) => GitHostAdapter;
}

const deny = (code: GitTransportDenyCode, message: string): GitTransportAnswer => ({
  decision: "deny",
  code,
  message,
});

interface BaseParts {
  readonly host: string;
  readonly path: string;
}

/** Host and path of a stored base URL when the proxy can reach it (https on 443), else undefined. */
export function reachableBase(baseUrl: string): BaseParts | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) return undefined;
  return { host: url.hostname.toLowerCase(), path: url.pathname.replace(/\/+$/, "") };
}

interface Facts {
  readonly connection: GitConnectionRecord | undefined;
  readonly organizations: readonly string[];
  readonly role: TeamRole | null;
}

async function readFacts(
  db: KobeDb,
  principal: GitTransportPrincipal,
  request: GitTransportRequest,
): Promise<Facts> {
  return withTeam(db, principal.teamId, async (tx) => {
    const all = await readGitConnections(tx, principal.teamId);
    const onHost = all.filter((c) => {
      const base = reachableBase(c.baseUrl);
      return base !== undefined && base.host === request.host && base.path === request.prefix;
    });
    const owner = request.owner.toLowerCase();
    const connection = onHost.find((c) => c.organization.toLowerCase() === owner);
    const [member] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.teamId, principal.teamId), eq(teamMembers.userId, principal.userId)),
      );
    return {
      connection,
      organizations: onHost.map((c) => c.organization),
      role: member?.role ?? null,
    };
  });
}

/**
 * The member's explicit roles on every Kaiju Repo (G15) the pushed repository is (review M3):
 * matched on the host's stable id within the connection's base URL under ANY connection (a
 * reconnect leaves `connection_id` cleared, G20) and also on the last-seen name (a rename or a
 * stale id must not lose the rule). Both match sets apply: fail closed.
 */
export async function repoProjectRoles(
  db: KobeDb,
  principal: GitTransportPrincipal,
  baseUrl: string,
  hostRepoId: string,
  fullName: string,
): Promise<{ readonly projectRole: "owner" | "editor" | undefined }[]> {
  return withTeam(db, principal.teamId, async (tx) => {
    const repos = await tx
      .select({ projectId: gitRepositories.projectId })
      .from(gitRepositories)
      .where(
        and(
          eq(gitRepositories.teamId, principal.teamId),
          eq(gitRepositories.baseUrl, baseUrl),
          sql`(${gitRepositories.hostRepoId} = ${hostRepoId} OR lower(${gitRepositories.fullName}) = ${fullName.toLowerCase()})`,
          sql`${gitRepositories.projectId} IS NOT NULL`,
        ),
      );
    const out: { projectRole: "owner" | "editor" | undefined }[] = [];
    for (const repo of repos) {
      const [row] = await tx
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.teamId, principal.teamId),
            eq(projectMembers.projectId, repo.projectId as string),
            eq(projectMembers.userId, principal.userId),
          ),
        );
      out.push({ projectRole: row?.role });
    }
    return out;
  });
}

/** A Kaiju Repo's record and the member's explicit role on its project (M4 read rule). */
export interface RepoReadRule {
  readonly hostRepoId: string;
  readonly fullName: string;
  readonly projectRole: "owner" | "editor" | undefined;
}

/** Whether any repository on `baseUrl` is a Kaiju Repo in the member's Workspace (no cap). */
export async function hostHasRepos(
  db: KobeDb,
  principal: Pick<GitTransportPrincipal, "teamId">,
  baseUrl: string,
): Promise<boolean> {
  return withTeam(db, principal.teamId, async (tx) => {
    const res = await tx.execute<{ any: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM git_repositories r
         WHERE r.team_id = ${principal.teamId} AND r.base_url = ${baseUrl}
           AND r.project_id IS NOT NULL) AS any`);
    return res.rows[0]?.any === true;
  });
}

/**
 * The Kaiju Repo records (a `git_repositories` row with a project) for `baseUrl` that match one of
 * `repos` by the host's id or by the last-seen name (either matches; fail closed), under any
 * connection (a reconnect clears `connection_id`, G20), with the member's explicit role on each
 * project. Asked per requested repository (or per listed page), never as a capped list of all
 * Repos (review g103 R2-L1).
 */
export async function repoReadRules(
  db: KobeDb,
  principal: Pick<GitTransportPrincipal, "teamId" | "userId">,
  baseUrl: string,
  repos: readonly { readonly id: string; readonly fullName: string }[],
): Promise<RepoReadRule[]> {
  if (repos.length === 0) return [];
  const ids = repos.map((r) => r.id);
  const names = repos.map((r) => r.fullName.toLowerCase());
  return withTeam(db, principal.teamId, async (tx) => {
    const res = await tx.execute<{
      host_repo_id: string;
      full_name: string;
      role: "owner" | "editor" | null;
    }>(sql`
      SELECT r.host_repo_id, r.full_name, m.role
        FROM git_repositories r
        LEFT JOIN project_members m
          ON m.team_id = r.team_id AND m.project_id = r.project_id AND m.user_id = ${principal.userId}
       WHERE r.team_id = ${principal.teamId} AND r.base_url = ${baseUrl}
         AND r.project_id IS NOT NULL
         AND (r.host_repo_id = ANY(${sql.param(ids)}::text[])
              OR lower(r.full_name) = ANY(${sql.param(names)}::text[]))`);
    return res.rows.map((r) => ({
      hostRepoId: r.host_repo_id,
      fullName: r.full_name,
      projectRole: r.role ?? undefined,
    }));
  });
}

/**
 * Owner decision 2026-11-22 (review g103 M4): reading a repository that is a Kaiju Repo needs a role
 * on its project (reader, editor or owner: {@link projectPermissions} `view`), matched by the
 * host's id and by the last-seen name, both applying (fail closed). Other repositories of the
 * organization need nothing more. `permissions` is replaceable in tests only.
 */
export function repoReadable(
  role: TeamRole,
  rules: readonly RepoReadRule[],
  repo: { readonly id: string; readonly fullName: string },
  permissions: typeof projectPermissions = projectPermissions,
): boolean {
  const name = repo.fullName.toLowerCase();
  return rules
    .filter((r) => r.hostRepoId === repo.id || r.fullName.toLowerCase() === name)
    .every((r) => permissions(role, r.projectRole).view);
}

/**
 * The access rules (G12) for a matched connection that need no host call; undefined when allowed
 * so far. A push to an organization repository that is not a Kaiju Repo needs exactly this: the
 * connection at Read and write and the Contributor role or above (G12). A Repo additionally needs
 * editor or owner on its project ({@link repoRefusal}, after the host id is known).
 */
export function accessRefusal(
  facts: Pick<Facts, "role">,
  connection: Pick<GitConnectionRecord, "accessLevel" | "agentIds" | "displayName">,
  service: GitService,
): GitTransportAnswer | undefined {
  if (connection.accessLevel === "off") {
    return deny("connection_off", `The git connection "${connection.displayName}" is turned off.`);
  }
  if (connection.agentIds !== null) {
    return deny(
      "agents_restricted",
      `The git connection "${connection.displayName}" is limited to chosen agents, so git in the sandbox cannot use it.`,
    );
  }
  if (facts.role === null) return deny("role_reader", "You are not a member of this Workspace.");
  if (service !== "git-receive-pack") return undefined;
  if (connection.accessLevel !== "read_write") {
    return deny(
      "read_only",
      `The git connection "${connection.displayName}" is read-only: pushing needs Read and write.`,
    );
  }
  if (facts.role === "member") {
    return deny(
      "role_reader",
      "Pushing needs the Contributor role in this Workspace; readers can fetch and clone.",
    );
  }
  return undefined;
}

/** A push to a Kaiju Repo needs editor or owner on every project the repository is the record of. */
export function repoRefusal(
  role: TeamRole,
  repos: readonly { readonly projectRole: "owner" | "editor" | undefined }[],
): GitTransportAnswer | undefined {
  if (repos.every((r) => projectPermissions(role, r.projectRole).edit)) return undefined;
  return deny(
    "project_reader",
    "This repository is a Repo: pushing needs the editor or owner role on its project.",
  );
}

function adapterRefusal(err: unknown): GitTransportAnswer {
  if (!(err instanceof GitHostError)) {
    return deny("host_unavailable", "The git host could not be reached; try again shortly.");
  }
  switch (err.code) {
    case "not_found":
    case "invalid_request":
      return deny(
        "repository_unavailable",
        "That repository does not exist in the connected organization, or the Workspace's credential cannot see it.",
      );
    case "forbidden":
      return deny(
        "credential_forbidden",
        "The Workspace's git credential is not allowed to do that on this repository.",
      );
    case "auth_failed":
      return deny(
        "credential_rejected",
        "The git host refused the Workspace's credential; a Workspace admin should check the connection.",
      );
    case "rate_limited":
      return deny("host_rate_limited", "The git host is rate limiting Kaiju; try again later.");
    case "host_refused":
      return deny("site_refused", "This Site does not allow that git host.");
    default:
      return deny("host_unavailable", "The git host could not be reached; try again shortly.");
  }
}

export async function decideGitTransport(
  deps: GitTransportDeps,
  principal: GitTransportPrincipal,
  request: GitTransportRequest,
): Promise<GitTransportAnswer> {
  if (principal.evalThreadId !== undefined) {
    return deny("eval_sandbox", "Skill evaluations do not use the Workspace's git connections.");
  }
  const facts = await readFacts(deps.db, principal, request);
  const { connection } = facts;
  if (!connection) {
    if (facts.organizations.length === 0) {
      return deny("no_connection", "No git connection for this host.");
    }
    return deny(
      "outside_organization",
      `${request.owner}/${request.repository} is outside the organization this Workspace connected on ${request.host} (${facts.organizations.join(", ")}).`,
    );
  }
  const refusal = accessRefusal(facts, connection, request.service);
  if (refusal) return refusal;

  let target;
  try {
    target = gitHostTarget(await readGitSiteSettings(deps.db), connection.baseUrl);
  } catch {
    return deny("site_refused", "This Site does not allow that git host now.");
  }
  if (!deps.envelope) {
    return deny("credential_unavailable", "Git credentials cannot be opened on this server.");
  }
  const sealed = await withTeam(deps.db, principal.teamId, (tx) =>
    readGitConnectionSealedCredential(tx, principal.teamId, connection.id),
  );
  if (!sealed) return deny("no_connection", "No git connection for this host.");
  let secret;
  try {
    secret = openGitCredential(
      deps.envelope,
      { teamId: principal.teamId, connectionId: connection.id },
      sealed.credentialSealed,
      sealed.credentialKind,
    );
  } catch {
    return deny(
      "credential_unavailable",
      "The Workspace's git credential could not be opened; a Workspace admin should replace it.",
    );
  }
  const access = request.service === "git-receive-pack" ? "write" : "read";
  try {
    const adapter = (deps.adapterFor ?? gitHostAdapter)({
      connection,
      secret,
      target,
      net: deps.net,
    });
    if (access === "read") {
      // M4 (owner decision 2026-11-22): a Repo is read only with a role on its project; refused
      // exactly as a missing repository. Only when the host has Repos recorded at all.
      if (await hostHasRepos(deps.db, principal, connection.baseUrl)) {
        const resolved = await adapter.getRepository({ name: request.repository });
        const rules = await repoReadRules(deps.db, principal, connection.baseUrl, [resolved]);
        if (!repoReadable(facts.role as TeamRole, rules, resolved)) {
          return adapterRefusal(new GitHostError("not_found", "Not found."));
        }
      }
    }
    if (access === "write") {
      // Review M3: resolve the host's stable id first; an unresolvable repository is refused
      // (fail closed), and a Kaiju Repo by id or by name keeps its project rule.
      const resolved = await adapter.getRepository({ name: request.repository });
      const repos = await repoProjectRoles(
        deps.db,
        principal,
        connection.baseUrl,
        resolved.id,
        `${connection.organization}/${request.repository}`,
      );
      const refused = repoRefusal(facts.role as TeamRole, repos);
      if (refused) return refused;
      // KOBE-766 (G17): a push to a Repo refreshes its mirror shortly after (the push itself
      // follows this decision). A failure here never refuses the push.
      if (repos.length > 0) {
        await requestPushRefresh(deps.db, principal.teamId, connection.baseUrl, resolved.id).catch(
          (err: unknown) => logger.warn({ err }, "git mirror refresh not requested"),
        );
      }
    }
    const credential = await adapter.repositoryCredential(request.repository, access);
    const base = reachableBase(connection.baseUrl);
    return {
      decision: "allow",
      connection_id: connection.id,
      base_path: base?.path ?? "",
      organization: connection.organization,
      repository: request.repository,
      access,
      username: credential.username,
      password: credential.password,
      expires_at: credential.expiresAt === null ? null : credential.expiresAt.toISOString(),
      narrowed: credential.narrowed,
      push_limit_bytes: connection.pushLimitBytes,
    };
  } catch (err) {
    return adapterRefusal(err);
  }
}
