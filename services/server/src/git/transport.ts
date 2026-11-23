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
  readonly projectRole: "owner" | "editor" | undefined;
  readonly isRepo: boolean;
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
    let projectRole: Facts["projectRole"];
    let isRepo = false;
    if (connection) {
      const fullName = `${connection.organization}/${request.repository}`.toLowerCase();
      const [repo] = await tx
        .select({ projectId: gitRepositories.projectId })
        .from(gitRepositories)
        .where(
          and(
            eq(gitRepositories.teamId, principal.teamId),
            eq(gitRepositories.connectionId, connection.id),
            sql`lower(${gitRepositories.fullName}) = ${fullName}`,
          ),
        );
      if (repo?.projectId) {
        isRepo = true;
        const [row] = await tx
          .select({ role: projectMembers.role })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.teamId, principal.teamId),
              eq(projectMembers.projectId, repo.projectId),
              eq(projectMembers.userId, principal.userId),
            ),
          );
        projectRole = row?.role;
      }
    }
    return {
      connection,
      organizations: onHost.map((c) => c.organization),
      role: member?.role ?? null,
      projectRole,
      isRepo,
    };
  });
}

/** The access rules (G12) for a matched connection; undefined when allowed. */
export function accessRefusal(
  facts: Pick<Facts, "role" | "projectRole" | "isRepo">,
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
  if (facts.isRepo && !projectPermissions(facts.role, facts.projectRole).edit) {
    return deny(
      "project_reader",
      "This repository is a Repo: pushing needs the editor or owner role on its project.",
    );
  }
  return undefined;
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
      return deny("host_rate_limited", "The git host is rate limiting Kobe; try again later.");
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
