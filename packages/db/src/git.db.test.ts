import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KaijuDatabase } from "./client.js";
import { Envelope } from "./envelope/envelope.js";
import { openGitCredential, rewrapGitCredential, sealGitCredential } from "./git/credential.js";
import {
  readGitConnection,
  readGitConnectionSealedCredential,
  readGitConnections,
} from "./git/records.js";
import { readGitSiteSettings } from "./git/site-settings.js";
import {
  gitConnections,
  gitConversions,
  gitRepositories,
  projects,
  siteSettings,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";
import { pgCodeOf } from "./pg-errors.js";

/** KOBE-757 (Workspace git GIT-1): the connection and repository tables and the sealed credential. */
let app: KaijuDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();

const connection = (teamId: string, over: Partial<typeof gitConnections.$inferInsert> = {}) => ({
  teamId,
  provider: "github" as const,
  baseUrl: "https://github.com",
  organization: `org-${randomUUID().slice(0, 8)}`,
  displayName: "Acme on GitHub",
  credentialKind: "access_token" as const,
  credentialSealed: "e1.kid.a.b.c.d.e.f",
  credentialKeyId: "kid",
  credentialHint: "••••1234",
  createdBy: userId,
  ...over,
});

async function insertConnection(teamId: string, over = {}) {
  const [row] = await withTeam(app.db, teamId, (tx) =>
    tx.insert(gitConnections).values(connection(teamId, over)).returning(),
  );
  if (!row) throw new Error("insert returned nothing");
  return row;
}

const refused = (code: string) => (e: unknown) => pgCodeOf(e) === code;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `gita-${teamA.slice(0, 8)}`, name: "Git A" },
    { id: teamB, slug: `gitb-${teamB.slice(0, 8)}`, name: "Git B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "G", email: `${userId}@git.test` });
});
afterAll(() => app.close());

describe("git_connections", () => {
  it("is invisible and unwritable outside its Workspace", async () => {
    const row = await insertConnection(teamA);
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(gitConnections))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(gitConnections).values(connection(teamA))),
    ).rejects.toSatisfy(refused("42501"));
    const del = await withTeam(app.db, teamB, (tx) =>
      tx.delete(gitConnections).where(eq(gitConnections.id, row.id)).returning(),
    );
    expect(del).toEqual([]);
    // Defaults (G1, G10, G11).
    expect(row).toMatchObject({
      accessLevel: "read",
      repoVisibility: "private",
      defaultBranch: "main",
      pushLimitBytes: 1024 ** 3,
      directCommits: false,
      agentIds: null,
      capabilities: { create: "unknown", read: "unknown", write: "unknown", admin: "unknown" },
      excessPermissions: [],
    });
  });

  it("connects an organization once per base URL, ignoring case (G2)", async () => {
    await insertConnection(teamA, { organization: "Acme" });
    await expect(insertConnection(teamA, { organization: "acme" })).rejects.toSatisfy(
      refused("23505"),
    );
    // Another host, or another Workspace, may connect the same organization.
    await insertConnection(teamA, { organization: "acme", baseUrl: "https://git.example.com" });
    await insertConnection(teamB, { organization: "acme" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["plaintext credential", { credentialSealed: "ghp_abcdef" }],
    ["unknown provider", { provider: "gitlab" }],
    ["http base URL", { baseUrl: "http://github.com" }],
    ["trailing slash", { baseUrl: "https://github.com/" }],
    ["upper-case host", { baseUrl: "https://GitHub.com" }],
    ["query in base URL", { baseUrl: "https://github.com?x=1" }],
    ["organization with a slash", { organization: "acme/repo" }],
    ["blank display name", { displayName: "  " }],
    ["unknown access level", { accessLevel: "admin" }],
    ["public visibility", { repoVisibility: "public" }],
    ["branch with ..", { defaultBranch: "a..b" }],
    ["zero push limit", { pushLimitBytes: 0 }],
    ["empty agent list", { agentIds: [] }],
    [
      "app on Gitea",
      {
        provider: "gitea",
        credentialKind: "github_app",
        credentialHint: null,
        githubAppId: 1,
        githubInstallationId: 2,
      },
    ],
    [
      "app without installation",
      { credentialKind: "github_app", credentialHint: null, githubAppId: 1 },
    ],
    ["token with an app id", { githubAppId: 1 }],
    ["capabilities not an object", { capabilities: [] }],
    [
      "capabilities of the old boolean shape",
      { capabilities: { create: true, read: "yes", write: "yes", admin: "no" } },
    ],
    [
      "capabilities with an extra key",
      { capabilities: { create: "yes", read: "yes", write: "yes", admin: "no", extra: "yes" } },
    ],
    ["capabilities missing a key", { capabilities: { create: "yes", read: "yes", write: "yes" } }],
    ["a key id the sealed text does not name", { credentialKeyId: "other" }],
    ["a null in the excess permissions", { excessPermissions: ["delete_repo", null] }],
  ])("refuses %s", async (_name, over) => {
    await expect(insertConnection(teamB, over)).rejects.toSatisfy(refused("23514"));
  });

  it("accepts a GitHub App connection and a Forgejo token on a path", async () => {
    await insertConnection(teamB, {
      credentialKind: "github_app",
      credentialHint: null,
      githubAppId: 123456,
      githubInstallationId: 98765432,
    });
    await insertConnection(teamB, {
      provider: "forgejo",
      baseUrl: "https://code.example.org:8443/forgejo",
      agentIds: [randomUUID()],
      accessLevel: "read_write",
      repoVisibility: "internal",
    });
  });
});

describe("git_repositories", () => {
  async function project(teamId: string) {
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const [p] = await withTeam(app.db, teamId, (tx) =>
      tx
        .insert(projects)
        .values({ teamId, slug, name: "Repo", kind: "repo", createdBy: userId })
        .returning({ id: projects.id }),
    );
    if (!p) throw new Error("insert returned nothing");
    return p.id;
  }

  const repo = (teamId: string, connectionId: string | null, projectId: string | null) => ({
    teamId,
    connectionId,
    baseUrl: "https://github.com",
    hostRepoId: String(Math.floor(Math.random() * 1e9)),
    fullName: "acme/docs",
    projectId,
    origin: "conversion" as const,
    createdBy: userId,
  });

  it("keeps the repository when its connection or project goes (G20)", async () => {
    const conn = await insertConnection(teamA);
    const projectId = await project(teamA);
    const [r] = await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(gitRepositories)
        .values(repo(teamA, conn.id, projectId))
        .returning(),
    );
    expect(r).toMatchObject({ hostState: "active", isPrivate: true, defaultBranchProtected: null });
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(gitConnections).where(eq(gitConnections.id, conn.id)),
    );
    await withTeam(app.db, teamA, (tx) => tx.delete(projects).where(eq(projects.id, projectId)));
    const [after] = await withTeam(app.db, teamA, (tx) =>
      tx
        .select()
        .from(gitRepositories)
        .where(eq(gitRepositories.id, r?.id ?? "")),
    );
    expect(after).toMatchObject({ connectionId: null, projectId: null, fullName: "acme/docs" });
  });

  it("is one Repo per project, and never points into another Workspace", async () => {
    const projectId = await project(teamA);
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitRepositories).values(repo(teamA, null, projectId)),
    );
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(gitRepositories).values(repo(teamA, null, projectId)),
      ),
    ).rejects.toSatisfy(refused("23505"));
    // teamA's project from teamB: the key includes team_id, so it does not exist there.
    await expect(
      withTeam(app.db, teamB, (tx) =>
        tx.insert(gitRepositories).values(repo(teamB, null, projectId)),
      ),
    ).rejects.toSatisfy(refused("23503"));
    const connA = await insertConnection(teamA);
    await expect(
      withTeam(app.db, teamB, (tx) =>
        tx.insert(gitRepositories).values(repo(teamB, connA.id, null)),
      ),
    ).rejects.toSatisfy(refused("23503"));
  });

  it("records one row per host repository, also after its connection went (L5)", async () => {
    const conn = await insertConnection(teamA);
    const first = { ...repo(teamA, conn.id, null), hostRepoId: "777" };
    await withTeam(app.db, teamA, (tx) => tx.insert(gitRepositories).values(first));
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(gitConnections).where(eq(gitConnections.id, conn.id)),
    );
    const again = await insertConnection(teamA);
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(gitRepositories).values({ ...first, connectionId: again.id }),
      ),
    ).rejects.toSatisfy(refused("23505"));
    // The same id on another host is another repository.
    await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(gitRepositories)
        .values({ ...first, connectionId: null, baseUrl: "https://git.example.com" }),
    );
  });

  it("goes with its Workspace along both cascade paths (L7)", async () => {
    const team = randomUUID();
    const owner = createDb(inject("ownerUrl"));
    try {
      await owner.db
        .insert(teams)
        .values({ id: team, slug: `gitd-${team.slice(0, 8)}`, name: "D" });
      const conn = await insertConnection(team);
      const projectId = await project(team);
      await withTeam(app.db, team, (tx) =>
        tx.insert(gitRepositories).values(repo(team, conn.id, projectId)),
      );
      await owner.db.delete(teams).where(eq(teams.id, team));
      const left = await owner.db
        .select({ id: gitRepositories.id })
        .from(gitRepositories)
        .where(eq(gitRepositories.teamId, team));
      expect(left).toEqual([]);
      const conns = await owner.db
        .select({ id: gitConnections.id })
        .from(gitConnections)
        .where(eq(gitConnections.teamId, team));
      expect(conns).toEqual([]);
    } finally {
      await owner.close();
    }
  });

  it("refuses an unknown project kind", async () => {
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(projects).values({
          teamId: teamA,
          slug: `k-${randomUUID().slice(0, 8)}`,
          name: "K",
          kind: "folder" as never,
          createdBy: userId,
        }),
      ),
    ).rejects.toSatisfy(refused("23514"));
  });
});

describe("git_conversions (KOBE-765)", () => {
  async function newProject(teamId: string) {
    const slug = `c-${randomUUID().slice(0, 8)}`;
    const [p] = await withTeam(app.db, teamId, (tx) =>
      tx
        .insert(projects)
        .values({ teamId, slug, name: "To convert", createdBy: userId })
        .returning({ id: projects.id }),
    );
    if (!p) throw new Error("insert returned nothing");
    return p.id;
  }
  const attempt = (
    teamId: string,
    projectId: string,
    over: Partial<typeof gitConversions.$inferInsert> = {},
  ) => ({
    teamId,
    projectId,
    requestedBy: userId,
    provider: "forgejo" as const,
    baseUrl: "https://git.example.test",
    organization: "acme",
    repositoryName: "docs",
    visibility: "private" as const,
    carryHistory: true,
    defaultBranch: "main",
    ...over,
  });

  it("holds a project with one running or failed attempt at a time; finished ones are history", async () => {
    const projectId = await newProject(teamA);
    const [first] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitConversions).values(attempt(teamA, projectId)).returning(),
    );
    expect(first).toMatchObject({
      status: "running",
      step: "create",
      attempts: 0,
      commitsPushed: 0,
    });
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(gitConversions).values(attempt(teamA, projectId))),
    ).rejects.toSatisfy(refused("23505"));
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(gitConversions)
        .set({ status: "abandoned", finishedAt: new Date() })
        .where(eq(gitConversions.id, first?.id ?? "")),
    );
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitConversions).values(attempt(teamA, projectId)),
    );
    // Invisible elsewhere; never points into another Workspace.
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(gitConversions))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(gitConversions).values(attempt(teamB, projectId))),
    ).rejects.toSatisfy(refused("23503"));
  });

  it("checks its shape: a completed attempt is done and names the host's repository", async () => {
    const projectId = await newProject(teamA);
    for (const over of [
      { repositoryName: "evil.git" },
      { visibility: "public" as never },
      { status: "completed" as const, finishedAt: new Date() },
      { status: "abandoned" as const },
      { lastError: "Not A Code" },
      { headSha: "xyz" },
    ]) {
      await expect(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(gitConversions).values(attempt(teamA, projectId, over)),
        ),
      ).rejects.toSatisfy(refused("23514"));
    }
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitConversions).values(
        attempt(teamA, projectId, {
          status: "completed",
          step: "done",
          hostRepoId: "42",
          finishedAt: new Date(),
        }),
      ),
    );
  });

  it("keeps the attempt when its connection goes, and goes with its project", async () => {
    const conn = await insertConnection(teamA);
    const projectId = await newProject(teamA);
    const [row] = await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(gitConversions)
        .values(attempt(teamA, projectId, { connectionId: conn.id, status: "failed" }))
        .returning(),
    );
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(gitConnections).where(eq(gitConnections.id, conn.id)),
    );
    const [kept] = await withTeam(app.db, teamA, (tx) =>
      tx
        .select()
        .from(gitConversions)
        .where(eq(gitConversions.id, row?.id ?? "")),
    );
    expect(kept).toMatchObject({ connectionId: null, baseUrl: "https://git.example.test" });
    await withTeam(app.db, teamA, (tx) => tx.delete(projects).where(eq(projects.id, projectId)));
    expect(
      await withTeam(app.db, teamA, (tx) =>
        tx
          .select()
          .from(gitConversions)
          .where(eq(gitConversions.id, row?.id ?? "")),
      ),
    ).toEqual([]);
  });
});

describe("sealed git credential (G8)", () => {
  it("is stored sealed and survives a rotation of the envelope key", async () => {
    const id = randomUUID();
    const ref = { teamId: teamA, connectionId: id };
    const oldKey = new Envelope("o".repeat(40));
    const sealed = sealGitCredential(oldKey, ref, {
      kind: "access_token",
      token: "ghp_secret123456",
    });
    await insertConnection(teamA, { id, ...sealed });
    const [stored] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(gitConnections).where(eq(gitConnections.id, id)),
    );
    expect(stored?.credentialSealed).not.toContain("ghp_secret");
    expect(stored?.credentialKeyId).toBe(oldKey.currentKeyId);

    // After rotation: the previous key still opens it; a rewrap moves it to the new key.
    const rotated = new Envelope(["n".repeat(40), "o".repeat(40)]);
    const value = stored?.credentialSealed ?? "";
    expect(openGitCredential(rotated, ref, value, "access_token")).toEqual({
      kind: "access_token",
      token: "ghp_secret123456",
    });
    const next = rewrapGitCredential(rotated, ref, value);
    await withTeam(app.db, teamA, (tx) =>
      tx.update(gitConnections).set(next).where(eq(gitConnections.id, id)),
    );
    const newOnly = new Envelope("n".repeat(40));
    expect(next.credentialKeyId).toBe(newOnly.currentKeyId);
    expect(openGitCredential(newOnly, ref, next.credentialSealed, "access_token").kind).toBe(
      "access_token",
    );
  });
});

describe("reading connections (review M2)", () => {
  it("returns records without the sealed credential; only the named reader returns it", async () => {
    const conn = await insertConnection(teamB, {
      capabilities: { create: "yes", read: "yes", write: "unknown", admin: "no" },
      excessPermissions: ["delete_repo"],
    });
    const record = await withTeam(app.db, teamB, (tx) => readGitConnection(tx, teamB, conn.id));
    expect(record).toMatchObject({
      id: conn.id,
      capabilities: { create: "yes", read: "yes", write: "unknown", admin: "no" },
      excessPermissions: ["delete_repo"],
    });
    expect(Object.keys(record ?? {})).not.toContain("credentialSealed");
    expect(Object.keys(record ?? {})).not.toContain("credentialKeyId");
    expect(JSON.stringify(record)).not.toContain("e1.");
    const all = await withTeam(app.db, teamB, (tx) => readGitConnections(tx, teamB));
    expect(all.some((r) => r.id === conn.id)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("e1.");
    // From another Workspace: nothing.
    expect(await withTeam(app.db, teamA, (tx) => readGitConnection(tx, teamB, conn.id))).toBe(
      undefined,
    );
    const sealed = await withTeam(app.db, teamB, (tx) =>
      readGitConnectionSealedCredential(tx, teamB, conn.id),
    );
    expect(sealed).toEqual({
      credentialKind: "access_token",
      credentialSealed: "e1.kid.a.b.c.d.e.f",
      credentialKeyId: "kid",
    });
  });
});

describe("Site ceiling (G3)", () => {
  it("defaults to on with no host limit, and reads stored values", async () => {
    // Other DB tests in this file never write these keys; the database is per suite.
    expect(await readGitSiteSettings(app.db)).toEqual({ enabled: true, allowedHosts: [] });
    await app.db.insert(siteSettings).values([
      { key: "git.connections_enabled", value: "false" },
      { key: "git.allowed_hosts", value: JSON.stringify(["github.com", "*.Example.com"]) },
    ]);
    expect(await readGitSiteSettings(app.db)).toEqual({
      enabled: false,
      allowedHosts: ["*.example.com", "github.com"],
    });
  });
});
