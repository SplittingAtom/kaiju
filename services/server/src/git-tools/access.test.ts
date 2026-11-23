import { describe, expect, it } from "vitest";
import { GIT_CAPABILITIES_UNKNOWN, type GitConnectionRecord } from "@kobe/db";
import { decideGitAccess, usableConnections, type GitToolFacts } from "./access.js";
import { gitToolByName, type GitToolDef } from "./catalog.js";
import { offeredGitTools } from "./listing.js";

/**
 * KOBE-762 (spec workspace-git G3, G9, G12, GQ8): who may use which connection with which tool.
 * ac-2: writes refused at Read, for readers and outside the Workspace's own connections.
 */
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_TEAMS = "cccccccc-0000-4000-8000-000000000003";
const AGENT = "dddddddd-0000-4000-8000-000000000004";
const OTHER_AGENT = "eeeeeeee-0000-4000-8000-000000000005";

function connection(over: Partial<GitConnectionRecord> = {}): GitConnectionRecord {
  const now = new Date();
  return {
    teamId: "11111111-0000-4000-8000-000000000000",
    id: A,
    provider: "github",
    baseUrl: "https://github.com",
    organization: "acme",
    displayName: "Acme on GitHub",
    credentialKind: "access_token",
    githubAppId: null,
    githubInstallationId: null,
    credentialHint: null,
    accessLevel: "read_write",
    repoVisibility: "private",
    repoNamePrefix: "",
    defaultBranch: "main",
    pushLimitBytes: 1,
    directCommits: false,
    agentIds: null,
    capabilities: GIT_CAPABILITIES_UNKNOWN,
    excessPermissions: [],
    lastCheckedAt: null,
    lastOkAt: null,
    lastError: null,
    credentialExpiresAt: null,
    expiryNotifiedAt: null,
    createdBy: "22222222-0000-4000-8000-000000000000",
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    credentialUpdatedAt: now,
    ...over,
  };
}

function facts(over: Partial<GitToolFacts> = {}): GitToolFacts {
  return {
    connections: [connection()],
    role: "contributor",
    runAgents: [AGENT],
    settings: { enabled: true, allowedHosts: [] },
    evalSandbox: false,
    ...over,
  };
}

const tool = (name: string): GitToolDef => {
  const t = gitToolByName(name);
  if (!t) throw new Error(name);
  return t;
};
const READ = tool("git_get_repository");
const WRITE = tool("git_open_pull_request");

describe("decideGitAccess", () => {
  it("reads at Read and above, for every member role", () => {
    for (const role of ["member", "contributor", "team_admin"] as const) {
      for (const accessLevel of ["read", "read_write"] as const) {
        const f = facts({ role, connections: [connection({ accessLevel })] });
        expect(decideGitAccess(READ, A, f)).toMatchObject({ ok: true });
      }
    }
  });

  it("refuses a write at Read, and for a reader (ac-2)", () => {
    const readOnly = facts({ connections: [connection({ accessLevel: "read" })] });
    expect(decideGitAccess(WRITE, A, readOnly)).toMatchObject({ ok: false, code: "read_only" });
    expect(decideGitAccess(WRITE, A, facts({ role: "member" }))).toMatchObject({
      ok: false,
      code: "role_reader",
    });
    expect(decideGitAccess(WRITE, A, facts({ role: "team_admin" }))).toMatchObject({ ok: true });
  });

  it("refuses everything on a connection turned off, and for a non-member", () => {
    const off = facts({ connections: [connection({ accessLevel: "off" })] });
    expect(decideGitAccess(READ, A, off)).toMatchObject({ ok: false, code: "connection_off" });
    expect(decideGitAccess(READ, A, facts({ role: null }))).toMatchObject({
      ok: false,
      code: "not_a_member",
    });
  });

  it("never finds another Workspace's connection (only this Workspace's rows are read)", () => {
    expect(decideGitAccess(READ, OTHER_TEAMS, facts())).toMatchObject({
      ok: false,
      code: "connection_not_found",
    });
    expect(decideGitAccess(WRITE, OTHER_TEAMS, facts())).toMatchObject({
      ok: false,
      code: "connection_not_found",
    });
  });

  it("limits a connection to chosen agents across every run of the sandbox (GQ8)", () => {
    const limited = [connection({ agentIds: [AGENT] })];
    expect(decideGitAccess(READ, A, facts({ connections: limited }))).toMatchObject({ ok: true });
    // A sibling run with another agent (or none) must not borrow the permitted agent's access.
    for (const runAgents of [[AGENT, OTHER_AGENT], [AGENT, null], [OTHER_AGENT], []]) {
      expect(decideGitAccess(READ, A, facts({ connections: limited, runAgents }))).toMatchObject({
        ok: false,
        code: "agents_restricted",
      });
    }
  });

  it("follows the Site switch and host list (G3)", () => {
    expect(
      decideGitAccess(READ, A, facts({ settings: { enabled: false, allowedHosts: [] } })),
    ).toMatchObject({ ok: false, code: "site_refused" });
    expect(
      decideGitAccess(
        READ,
        A,
        facts({ settings: { enabled: true, allowedHosts: ["gitea.example"] } }),
      ),
    ).toMatchObject({ ok: false, code: "site_refused" });
    expect(
      decideGitAccess(
        READ,
        A,
        facts({ settings: { enabled: true, allowedHosts: ["github.com"] } }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("chooses the only usable connection, and asks to name one when there are several", () => {
    expect(decideGitAccess(READ, undefined, facts())).toMatchObject({
      ok: true,
      connection: { id: A },
    });
    const two = facts({
      connections: [connection(), connection({ id: B, organization: "beta", displayName: "Beta" })],
    });
    const many = decideGitAccess(READ, undefined, two);
    expect(many).toMatchObject({ ok: false, code: "connection_required" });
    expect(many.ok ? "" : many.message).toContain(B);
    // A read-only second connection leaves one usable for writes.
    const oneWritable = facts({
      connections: [connection(), connection({ id: B, accessLevel: "read" })],
    });
    expect(decideGitAccess(WRITE, undefined, oneWritable)).toMatchObject({
      ok: true,
      connection: { id: A },
    });
    expect(decideGitAccess(READ, undefined, facts({ connections: [] }))).toMatchObject({
      ok: false,
      code: "no_git_connection",
    });
  });

  it("gives skill evaluations nothing", () => {
    expect(decideGitAccess(READ, A, facts({ evalSandbox: true }))).toMatchObject({
      ok: false,
      code: "eval_sandbox",
    });
    expect(offeredGitTools(facts({ evalSandbox: true }))).toEqual([]);
  });
});

describe("offering", () => {
  const names = (f: GitToolFacts) => offeredGitTools(f).map((t) => t.name);

  it("offers reads at Read, writes too at Read and write for a contributor", () => {
    const reads = names(facts({ connections: [connection({ accessLevel: "read" })] }));
    expect(reads).toContain("git_list_repositories");
    expect(reads).not.toContain("git_open_pull_request");
    expect(names(facts())).toEqual(
      expect.arrayContaining(["git_create_repository", "git_create_branch", "git_comment"]),
    );
    expect(names(facts({ role: "member" }))).not.toContain("git_create_issue");
    expect(names(facts({ connections: [] }))).toEqual([]);
    expect(names(facts({ connections: [connection({ accessLevel: "off" })] }))).toEqual([]);
  });

  it("leaves out connections the Site or the agent list refuses", () => {
    expect(
      usableConnections(facts({ settings: { enabled: false, allowedHosts: [] } }), "read"),
    ).toEqual([]);
    expect(
      usableConnections(facts({ connections: [connection({ agentIds: [OTHER_AGENT] })] }), "read"),
    ).toEqual([]);
  });
});
