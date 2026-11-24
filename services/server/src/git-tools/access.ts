import {
  and,
  eq,
  readGitConnections,
  readGitSiteSettings,
  sql,
  teamMembers,
  withTeam,
  type GitConnectionRecord,
  type GitSiteSettings,
  type KaijuDb,
  type TeamRole,
} from "@kaiju/db";
import { gitHostTarget } from "../git-hosts/target.js";
import type { GitToolDef } from "./catalog.js";

/**
 * Who may use which git connection with which tool, right now (spec workspace-git G3, G9, G12,
 * GQ8; KOBE-762). Re-read from the database for every list, every sandbox `policy.check`, every
 * MCP proxy re-check and again just before the host is called, so a change by an admin (level,
 * agents, Site switch or host list, the member's role) applies to the next call:
 *
 * - the connection must be one of **this** Workspace's (rows are read under its RLS: another
 *   Workspace's id is simply not there), not at **Off**;
 * - reads need **Read** or above and membership; writes need **Read and write** and the
 *   Contributor role or above (G12; a Repo also needs editor or owner on its project, checked by
 *   the executor once the host's repository id is known);
 * - a connection limited to chosen agents (GQ8) is usable only when every active run of the
 *   sandbox is one of those agents: one sandbox serves every run of its member, and the server
 *   cannot tell which run sent an MCP call (KOBE-777/800), so naming a permitted sibling run must
 *   not buy access;
 * - the Site must allow the host (`gitHostTarget()`, G3: switch, host list, base URL rules);
 * - skill evaluations never use the Workspace's git connections.
 */

export interface GitToolPrincipal {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly evalThreadId?: string;
}

export interface GitToolFacts {
  readonly connections: readonly GitConnectionRecord[];
  readonly role: TeamRole | null;
  /** The agent id of every active run leased to the sandbox (null: a run without an agent). */
  readonly runAgents: readonly (string | null)[];
  readonly settings: GitSiteSettings;
  readonly evalSandbox: boolean;
}

export type GitDenyCode =
  | "no_git_connection"
  | "connection_required"
  | "connection_not_found"
  | "connection_off"
  | "read_only"
  | "role_reader"
  | "not_a_member"
  | "agents_restricted"
  | "site_refused"
  | "eval_sandbox";

export type GitAccessDecision =
  | { readonly ok: true; readonly connection: GitConnectionRecord }
  | { readonly ok: false; readonly code: GitDenyCode; readonly message: string };

const deny = (code: GitDenyCode, message: string): GitAccessDecision => ({
  ok: false,
  code,
  message,
});

export async function loadGitToolFacts(
  db: KaijuDb,
  principal: GitToolPrincipal,
): Promise<GitToolFacts> {
  const settings = await readGitSiteSettings(db);
  return withTeam(db, principal.teamId, async (tx) => {
    const connections = await readGitConnections(tx, principal.teamId);
    const [member] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.teamId, principal.teamId), eq(teamMembers.userId, principal.userId)),
      );
    const runs = await tx.execute<{ agent_id: string | null }>(sql`
      SELECT t.agent_id
        FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        JOIN sandbox_run_leases l ON l.team_id = r.team_id AND l.run_id = r.id
       WHERE r.team_id = ${principal.teamId} AND t.team_id = ${principal.teamId}
         AND r.status IN ('running', 'waiting_approval') AND r.kind = 'message'
         AND t.owner_user_id = ${principal.userId}
         AND l.user_id = ${principal.userId} AND l.sandbox_id = ${principal.sandboxId}
       LIMIT 64`);
    return {
      connections,
      role: member?.role ?? null,
      runAgents: runs.rows.map((r) => r.agent_id),
      settings,
      evalSandbox: principal.evalThreadId !== undefined,
    };
  });
}

/** Every active run's agent is on the connection's list (GQ8); any connection without a list. */
export function agentsAllow(
  connection: Pick<GitConnectionRecord, "agentIds">,
  runAgents: readonly (string | null)[],
): boolean {
  if (connection.agentIds === null) return true;
  const allowed = new Set(connection.agentIds);
  return runAgents.length > 0 && runAgents.every((a) => a !== null && allowed.has(a));
}

function siteAllows(settings: GitSiteSettings, baseUrl: string): boolean {
  try {
    gitHostTarget(settings, baseUrl);
    return true;
  } catch {
    return false;
  }
}

/** Connections the agent may use at `access` now (for the listing and for an implicit choice). */
export function usableConnections(
  facts: GitToolFacts,
  access: "read" | "write",
): GitConnectionRecord[] {
  if (facts.evalSandbox || facts.role === null) return [];
  if (access === "write" && facts.role === "member") return [];
  return facts.connections.filter(
    (c) =>
      c.accessLevel !== "off" &&
      (access === "read" || c.accessLevel === "read_write") &&
      agentsAllow(c, facts.runAgents) &&
      siteAllows(facts.settings, c.baseUrl),
  );
}

const named = (c: GitConnectionRecord) => `"${c.displayName}" (${c.id})`;

/** The decision for one call of `tool` naming (or not) a connection. */
export function decideGitAccess(
  tool: Pick<GitToolDef, "access" | "name">,
  connectionId: string | undefined,
  facts: GitToolFacts,
): GitAccessDecision {
  if (facts.evalSandbox) {
    return deny("eval_sandbox", "Skill evaluations do not use the Workspace's git connections.");
  }
  if (facts.role === null) return deny("not_a_member", "You are not a member of this Workspace.");
  let connection: GitConnectionRecord | undefined;
  if (connectionId === undefined) {
    const usable = usableConnections(facts, tool.access);
    if (usable.length === 0) {
      return deny(
        "no_git_connection",
        tool.access === "write"
          ? "No git connection this agent may write with: it needs a connection at Read and write and the Contributor role or above."
          : "This Workspace has no git connection this agent may use.",
      );
    }
    if (usable.length > 1) {
      return deny(
        "connection_required",
        `Name the connection: ${usable.map(named).join(", ")}.`.slice(0, 900),
      );
    }
    connection = usable[0];
  } else {
    connection = facts.connections.find((c) => c.id === connectionId.toLowerCase());
  }
  if (connection === undefined) {
    return deny("connection_not_found", "No git connection with that id in this Workspace.");
  }
  if (connection.accessLevel === "off") {
    return deny("connection_off", `The git connection ${named(connection)} is turned off.`);
  }
  if (!agentsAllow(connection, facts.runAgents)) {
    return deny(
      "agents_restricted",
      `The git connection ${named(connection)} is limited to chosen agents, and a conversation running in this sandbox uses another agent.`,
    );
  }
  if (tool.access === "write") {
    if (connection.accessLevel !== "read_write") {
      return deny(
        "read_only",
        `The git connection ${named(connection)} is read-only: ${tool.name} needs Read and write.`,
      );
    }
    if (facts.role === "member") {
      return deny(
        "role_reader",
        `${tool.name} needs the Contributor role in this Workspace; readers can use the read tools.`,
      );
    }
  }
  if (!siteAllows(facts.settings, connection.baseUrl)) {
    return deny("site_refused", "This Site does not allow that git host now.");
  }
  return { ok: true, connection };
}

/** The agent of the run a call was decided for (audit only). */
export async function namedRunAgent(
  db: KaijuDb,
  teamId: string,
  runId: string,
): Promise<string | null> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ agent_id: string | null }>(sql`
      SELECT t.agent_id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND t.team_id = ${teamId} AND r.id = ${runId}`),
  );
  return res.rows[0]?.agent_id ?? null;
}
