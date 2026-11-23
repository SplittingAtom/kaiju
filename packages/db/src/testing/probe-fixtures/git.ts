import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  gitCommitBranches,
  gitConnections,
  gitConversions,
  gitRepositories,
  gitWorkingCopies,
  projects,
  users,
} from "../../schema/index.js";
import type { git } from "../../tenancy/git.js";
import type { ProbeFixture } from "./types.js";

async function insertConnection(tx: KobeTx, teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [connection] = await tx
    .insert(gitConnections)
    .values({
      teamId,
      provider: "forgejo",
      baseUrl: "https://git.probe.test",
      organization: `probe-${randomUUID().slice(0, 8)}`,
      displayName: "Probe on Forgejo",
      credentialKind: "access_token",
      // Opaque envelope-shaped text: the probe never decrypts it.
      credentialSealed: "e1.probe.not-a-real-envelope",
      credentialKeyId: "probe",
      credentialHint: "••••test",
      createdBy: userId,
    })
    .returning({ id: gitConnections.id });
  if (!connection) throw new Error("probe: git connection insert returned nothing");
  return { connectionId: connection.id, userId };
}

/** A Repo: a connection, a project of kind `repo` and its repository row. */
async function insertRepo(tx: KobeTx, teamId: string) {
  const { connectionId, userId } = await insertConnection(tx, teamId);
  const slug = `probe-${randomUUID().slice(0, 8)}`;
  const [project] = await tx
    .insert(projects)
    .values({ teamId, slug, name: "Probe repo", kind: "repo", createdBy: userId })
    .returning({ id: projects.id });
  if (!project) throw new Error("probe: project insert returned nothing");
  const [repo] = await tx
    .insert(gitRepositories)
    .values({
      teamId,
      connectionId,
      baseUrl: "https://git.probe.test",
      hostRepoId: randomUUID().slice(0, 8),
      fullName: `probe/${slug}`,
      projectId: project.id,
      origin: "conversion",
      createdBy: userId,
    })
    .returning({ id: gitRepositories.id });
  if (!repo) throw new Error("probe: repository insert returned nothing");
  return { userId, projectId: project.id, repositoryId: repo.id };
}

export const gitFixtures: Record<(typeof git.team)[number], ProbeFixture> = {
  git_connections: async (tx, teamId) => {
    await insertConnection(tx, teamId);
  },
  git_repositories: async (tx, teamId) => {
    const { connectionId, userId } = await insertConnection(tx, teamId);
    const slug = `probe-${randomUUID().slice(0, 8)}`;
    const [project] = await tx
      .insert(projects)
      .values({ teamId, slug, name: "Probe repo", kind: "repo", createdBy: userId })
      .returning({ id: projects.id });
    if (!project) throw new Error("probe: project insert returned nothing");
    await tx.insert(gitRepositories).values({
      teamId,
      connectionId,
      baseUrl: "https://git.probe.test",
      hostRepoId: "42",
      fullName: `probe/${slug}`,
      projectId: project.id,
      origin: "conversion",
      createdBy: userId,
    });
  },
  git_conversions: async (tx, teamId) => {
    const { connectionId, userId } = await insertConnection(tx, teamId);
    const slug = `probe-${randomUUID().slice(0, 8)}`;
    const [project] = await tx
      .insert(projects)
      .values({ teamId, slug, name: "Probe conversion", createdBy: userId })
      .returning({ id: projects.id });
    if (!project) throw new Error("probe: project insert returned nothing");
    await tx.insert(gitConversions).values({
      teamId,
      projectId: project.id,
      connectionId,
      requestedBy: userId,
      provider: "forgejo",
      baseUrl: "https://git.probe.test",
      organization: "probe",
      repositoryName: slug,
      visibility: "private",
      carryHistory: true,
      defaultBranch: "main",
    });
  },
  git_commit_branches: async (tx, teamId) => {
    const { userId, projectId, repositoryId } = await insertRepo(tx, teamId);
    await tx.insert(gitCommitBranches).values({
      teamId,
      projectId,
      userId,
      repositoryId,
      baseCommitId: randomUUID(),
      baseSha: "a".repeat(40),
      branch: "kobe/probe",
      headSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      pullNumber: 1,
    });
  },
  git_working_copies: async (tx, teamId) => {
    const { userId, projectId } = await insertRepo(tx, teamId);
    await tx.insert(gitWorkingCopies).values({
      teamId,
      projectId,
      userId,
      branch: "main",
      headSha: "a".repeat(40),
      upstream: "origin/main",
    });
  },
};
