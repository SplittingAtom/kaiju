import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  gitConnections,
  gitConversions,
  gitRepositories,
  gitRepositoryCommits,
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

async function insertRepository(tx: KobeTx, teamId: string): Promise<string> {
  const { connectionId, userId } = await insertConnection(tx, teamId);
  const slug = `probe-${randomUUID().slice(0, 8)}`;
  const [project] = await tx
    .insert(projects)
    .values({ teamId, slug, name: "Probe repo", kind: "repo", createdBy: userId })
    .returning({ id: projects.id });
  if (!project) throw new Error("probe: project insert returned nothing");
  const [repository] = await tx
    .insert(gitRepositories)
    .values({
      teamId,
      connectionId,
      baseUrl: "https://git.probe.test",
      hostRepoId: randomUUID(),
      fullName: `probe/${slug}`,
      projectId: project.id,
      origin: "conversion",
      createdBy: userId,
    })
    .returning({ id: gitRepositories.id });
  if (!repository) throw new Error("probe: git repository insert returned nothing");
  return repository.id;
}

export const gitFixtures: Record<(typeof git.team)[number], ProbeFixture> = {
  git_connections: async (tx, teamId) => {
    await insertConnection(tx, teamId);
  },
  git_repositories: async (tx, teamId) => {
    await insertRepository(tx, teamId);
  },
  git_repository_commits: async (tx, teamId) => {
    const repositoryId = await insertRepository(tx, teamId);
    await tx.insert(gitRepositoryCommits).values({
      teamId,
      repositoryId,
      position: 0,
      sha: "a".repeat(40),
      authorName: "Probe",
      authoredAt: new Date(),
      message: "Probe commit",
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
};
