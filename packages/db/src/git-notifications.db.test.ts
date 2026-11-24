import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KaijuDatabase } from "./client.js";
import {
  gitConnections,
  gitConversions,
  notifications,
  projects,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";
import { pgCodeOf } from "./pg-errors.js";

/**
 * KOBE-819: the git notification kinds. What each names (`notifications_git` and the shape
 * check), once per conversion end and per connection, expiry and admin (the unique indexes),
 * and removed with their conversion or connection (the foreign keys); team-isolated by RLS.
 */
type NewNotification = typeof notifications.$inferInsert;
let app: KaijuDatabase;
let owner: KaijuDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();

async function seed(teamId: string) {
  return withTeam(app.db, teamId, async (tx) => {
    const [connection] = await tx
      .insert(gitConnections)
      .values({
        teamId,
        provider: "forgejo",
        baseUrl: "https://git.notes.test",
        organization: `acme-${randomUUID().slice(0, 8)}`,
        displayName: "Acme on Forgejo",
        credentialKind: "access_token",
        credentialSealed: "e1.test.not-a-real-envelope",
        credentialKeyId: "test",
        createdBy: userId,
      })
      .returning({ id: gitConnections.id });
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const [project] = await tx
      .insert(projects)
      .values({ teamId, slug, name: "Notes", createdBy: userId })
      .returning({ id: projects.id });
    if (!connection || !project) throw new Error("seed");
    const [conversion] = await tx
      .insert(gitConversions)
      .values({
        teamId,
        projectId: project.id,
        connectionId: connection.id,
        requestedBy: userId,
        provider: "forgejo",
        baseUrl: "https://git.notes.test",
        organization: "acme",
        repositoryName: slug,
        visibility: "private",
        carryHistory: true,
        defaultBranch: "main",
      })
      .returning({ id: gitConversions.id });
    if (!conversion) throw new Error("seed");
    return { connectionId: connection.id, projectId: project.id, conversionId: conversion.id };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;
const done = (teamId: string, s: Seeded, attempt = 1): NewNotification => ({
  teamId,
  userId,
  kind: "git.conversion.completed",
  gitConversionId: s.conversionId,
  gitAttempt: attempt,
});
const failed = (teamId: string, s: Seeded, attempt = 1): NewNotification => ({
  ...done(teamId, s, attempt),
  kind: "git.conversion.failed",
  gitFailure: "host_unreachable",
});
const expiring = (teamId: string, s: Seeded): NewNotification => ({
  teamId,
  userId,
  kind: "git.connection.token_expiring",
  gitConnectionId: s.connectionId,
  gitExpiresAt: new Date("2026-12-01T00:00:00Z"),
});

const insert = (teamId: string, row: NewNotification) =>
  withTeam(app.db, teamId, (tx) => tx.insert(notifications).values(row));

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `gn-${teamA.slice(0, 8)}`, name: "Git notes A" },
    { id: teamB, slug: `gm-${teamB.slice(0, 8)}`, name: "Git notes B" },
  ]);
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "G", email: `${userId}@g.test` });
});
afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("git notifications (KOBE-819)", () => {
  it("accepts each kind with what it names, team-isolated", async () => {
    const s = await seed(teamA);
    await insert(teamA, done(teamA, s));
    await insert(teamA, failed(teamA, s, 2));
    await insert(teamA, expiring(teamA, s));
    const mine = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(notifications).where(eq(notifications.gitConversionId, s.conversionId)),
    );
    expect(mine).toHaveLength(2);
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(notifications))).toEqual([]);
    await expect(insert(teamB, done(teamA, s, 9))).rejects.toSatisfy(
      (e) => pgCodeOf(e) === "42501",
    );
  });

  it("refuses what a git kind does not name, and git columns on other kinds", async () => {
    const s = await seed(teamA);
    const bad: NewNotification[] = [
      { ...done(teamA, s), gitConversionId: null },
      { ...done(teamA, s), gitAttempt: null },
      { ...done(teamA, s), gitFailure: "host_unreachable" },
      { ...done(teamA, s), gitConnectionId: s.connectionId },
      { ...failed(teamA, s), gitFailure: null },
      { ...failed(teamA, s), gitFailure: "Not A Code" },
      { ...expiring(teamA, s), gitExpiresAt: null },
      { ...expiring(teamA, s), gitConversionId: s.conversionId, gitAttempt: 1 },
      { ...expiring(teamA, s), threadId: randomUUID(), runId: randomUUID() },
      { ...expiring(teamA, s), projectId: s.projectId },
      { ...expiring(teamA, s), actorUserId: userId },
      { ...expiring(teamA, s), kind: "git.nope" as NewNotification["kind"] },
      {
        teamId: teamA,
        userId,
        kind: "team.member.added",
        actorUserId: userId,
        gitConnectionId: s.connectionId,
        gitExpiresAt: new Date(),
      },
    ];
    for (const row of bad) {
      await expect(insert(teamA, row), JSON.stringify(row)).rejects.toSatisfy((e) =>
        ["23514", "23503"].includes(pgCodeOf(e) ?? ""),
      );
    }
  });

  it("holds one notification per conversion end and per connection, expiry and admin", async () => {
    const s = await seed(teamA);
    await insert(teamA, failed(teamA, s, 1));
    await expect(insert(teamA, failed(teamA, s, 1))).rejects.toSatisfy(
      (e) => pgCodeOf(e) === "23505",
    );
    // Another end of the same attempt (a retry failed again, then it finished) is new.
    await insert(teamA, failed(teamA, s, 2));
    await insert(teamA, done(teamA, s, 3));
    await insert(teamA, expiring(teamA, s));
    await expect(insert(teamA, expiring(teamA, s))).rejects.toSatisfy(
      (e) => pgCodeOf(e) === "23505",
    );
    // A new credential with another expiry is a new notice.
    await insert(teamA, { ...expiring(teamA, s), gitExpiresAt: new Date("2027-01-01T00:00:00Z") });
  });

  it("goes with its project's conversion and with its connection", async () => {
    const s = await seed(teamA);
    await insert(teamA, done(teamA, s));
    await insert(teamA, expiring(teamA, s));
    const count = async () =>
      (
        await withTeam(app.db, teamA, (tx) =>
          tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(eq(notifications.userId, userId)),
        )
      ).length;
    const before = await count();
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(gitConnections).where(eq(gitConnections.id, s.connectionId)),
    );
    expect(await count()).toBe(before - 1);
    await withTeam(app.db, teamA, (tx) => tx.delete(projects).where(eq(projects.id, s.projectId)));
    expect(await count()).toBe(before - 2);
  });
});
