import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KaijuDatabase } from "./client.js";
import { pgCodeOf } from "./pg-errors.js";
import {
  gitCommitBranches,
  gitConnections,
  gitRepositories,
  gitWorkingCopies,
  projects,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-767: members' pull-request branches and Repo working copies. */
let app: KaijuDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const SHA = "a".repeat(40);
const refused = (code: string) => (e: unknown) => pgCodeOf(e) === code;
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a row");
  return v;
};

async function repo(teamId: string) {
  return withTeam(app.db, teamId, async (tx) => {
    const [c] = await tx
      .insert(gitConnections)
      .values({
        teamId,
        provider: "forgejo",
        baseUrl: "https://git.acme.test",
        organization: `org-${randomUUID().slice(0, 8)}`,
        displayName: "Acme",
        credentialKind: "access_token",
        credentialSealed: "e1.kid.a.b",
        credentialKeyId: "kid",
        createdBy: userId,
      })
      .returning();
    const slug = `r-${randomUUID().slice(0, 8)}`;
    const [p] = await tx
      .insert(projects)
      .values({ teamId, slug, name: "R", kind: "repo", createdBy: userId })
      .returning();
    const [r] = await tx
      .insert(gitRepositories)
      .values({
        teamId,
        connectionId: must(c).id,
        baseUrl: "https://git.acme.test",
        hostRepoId: randomUUID().slice(0, 8),
        fullName: `acme/${slug}`,
        projectId: must(p).id,
        origin: "conversion",
        createdBy: userId,
      })
      .returning();
    return { projectId: must(p).id, repositoryId: must(r).id };
  });
}

const branchRow = (teamId: string, ids: { projectId: string; repositoryId: string }) => ({
  teamId,
  projectId: ids.projectId,
  userId,
  repositoryId: ids.repositoryId,
  baseCommitId: randomUUID(),
  baseSha: SHA,
  branch: "kobe/ada/fix-1234567",
  headSha: "b".repeat(40),
  treeSha: "c".repeat(40),
  pullNumber: 3,
  pullUrl: "https://git.acme.test/acme/r/pulls/3",
});

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `grwa-${teamA.slice(0, 8)}`, name: "A" },
    { id: teamB, slug: `grwb-${teamB.slice(0, 8)}`, name: "B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "G", email: `${userId}@grw.test` });
});
afterAll(() => app.close());

describe("git_commit_branches (KOBE-767)", () => {
  it("is one row per member and Repo, invisible outside its Workspace", async () => {
    const ids = await repo(teamA);
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitCommitBranches).values(branchRow(teamA, ids)),
    );
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(gitCommitBranches).values(branchRow(teamA, ids))),
    ).rejects.toSatisfy(refused("23505"));
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(gitCommitBranches))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(gitCommitBranches).values(branchRow(teamA, ids))),
    ).rejects.toSatisfy(refused("42501"));
  });

  it("checks commit ids, branch names and links", async () => {
    const ids = await repo(teamA);
    for (const bad of [
      { headSha: "zz" },
      { branch: "a b" },
      { branch: "a..b" },
      { pullNumber: 0 },
      { pullUrl: "javascript:alert(1)" },
    ]) {
      await expect(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(gitCommitBranches).values({ ...branchRow(teamA, ids), ...bad }),
        ),
        JSON.stringify(bad),
      ).rejects.toSatisfy(refused("23514"));
    }
  });

  it("goes with its project or repository row", async () => {
    const ids = await repo(teamA);
    await withTeam(app.db, teamA, async (tx) => {
      await tx.insert(gitCommitBranches).values(branchRow(teamA, ids));
      await tx.insert(gitWorkingCopies).values({ teamId: teamA, projectId: ids.projectId, userId });
      await tx.delete(projects).where(eq(projects.id, ids.projectId));
      expect(
        await tx
          .select()
          .from(gitCommitBranches)
          .where(eq(gitCommitBranches.projectId, ids.projectId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(gitWorkingCopies)
          .where(eq(gitWorkingCopies.projectId, ids.projectId)),
      ).toEqual([]);
    });
  });
});

describe("git_working_copies (KOBE-767)", () => {
  it("holds bounded counts and names, per member and Repo", async () => {
    const ids = await repo(teamA);
    const row = { teamId: teamA, projectId: ids.projectId, userId };
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(gitWorkingCopies).values({ ...row, branch: "fix/x", headSha: SHA, ahead: 2 }),
    );
    for (const bad of [{ ahead: -1 }, { behind: 10_001 }, { headSha: "x" }, { branch: "a b" }]) {
      await expect(
        withTeam(app.db, teamA, (tx) =>
          tx.update(gitWorkingCopies).set(bad).where(eq(gitWorkingCopies.projectId, ids.projectId)),
        ),
        JSON.stringify(bad),
      ).rejects.toSatisfy(refused("23514"));
    }
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(gitWorkingCopies))).toEqual([]);
  });
});
