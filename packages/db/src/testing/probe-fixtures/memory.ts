import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  portableMemoryItemVersions,
  portableMemoryItems,
  runMemoryItems,
  runPortableMemoryItems,
  runSiteMemoryItems,
  runs,
  semanticMemoryItemVersions,
  semanticMemoryItems,
  memoryCandidates,
  memoryDismissals,
  memoryLearningPasses,
  memoryLearningWatermarks,
  memoryProposals,
  memoryProjectSuggestions,
  memoryReminders,
  memoryStewards,
  projects,
  siteMemoryItemVersions,
  siteMemoryItems,
  teamMembers,
  threadEntries,
  threads,
  users,
} from "../../schema/index.js";
import type { memory } from "../../tenancy/memory.js";
import type { ProbeFixture } from "./types.js";

async function insertUser(tx: KobeTx): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  return userId;
}

/** A thread of `userId` with one run, for run records to hang off. */
async function insertRun(tx: KobeTx, teamId: string, userId: string): Promise<string> {
  const [thread] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, title: "Probe" })
    .returning({ id: threads.id });
  if (!thread) throw new Error("probe: thread insert returned nothing");
  const [run] = await tx
    .insert(runs)
    .values({
      teamId,
      threadId: thread.id,
      trigger: "user",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: runs.id });
  if (!run) throw new Error("probe: run insert returned nothing");
  return run.id;
}

/** A personal Workspace item with its first version (one transaction: deferred version key). */
async function insertItem(tx: KobeTx, teamId: string) {
  const userId = await insertUser(tx);
  const [item] = await tx
    .insert(semanticMemoryItems)
    .values({ teamId, scope: "user", ownerUserId: userId, kind: "preference" })
    .returning({ id: semanticMemoryItems.id });
  if (!item) throw new Error("probe: semantic memory item insert returned nothing");
  await tx.insert(semanticMemoryItemVersions).values({
    teamId,
    itemId: item.id,
    version: 1,
    statement: "Prefers metric units",
    actorKind: "user",
    actorUserId: userId,
  });
  return { itemId: item.id, userId };
}

/** A thread of a new user with one entry `e1`, for learning rows to hang off. */
async function insertThread(tx: KobeTx, teamId: string) {
  const userId = await insertUser(tx);
  const [thread] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, title: "Probe" })
    .returning({ id: threads.id });
  if (!thread) throw new Error("probe: thread insert returned nothing");
  await tx
    .insert(threadEntries)
    .values({ teamId, threadId: thread.id, entryId: "e1", type: "message" });
  return { threadId: thread.id, userId };
}

/** A queued learning pass over that thread. */
async function insertPass(tx: KobeTx, teamId: string) {
  const { threadId, userId } = await insertThread(tx, teamId);
  const [pass] = await tx
    .insert(memoryLearningPasses)
    .values({
      teamId,
      threadId,
      userId,
      branchLeafEntryId: "e1",
      modelAlias: "learner",
      promptVersion: "v1",
    })
    .returning({ id: memoryLearningPasses.id });
  if (!pass) throw new Error("probe: pass insert returned nothing");
  return { passId: pass.id, threadId, userId };
}

export const memoryFixtures: Record<(typeof memory.team)[number], ProbeFixture> = {
  semantic_memory_items: async (tx, teamId) => {
    await insertItem(tx, teamId);
  },
  semantic_memory_item_versions: async (tx, teamId) => {
    await insertItem(tx, teamId);
  },
  run_memory_items: async (tx, teamId) => {
    const { itemId, userId } = await insertItem(tx, teamId);
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runMemoryItems).values({ teamId, runId, itemId, version: 1 });
  },
  run_portable_memory_items: async (tx, teamId) => {
    const userId = await insertUser(tx);
    const [item] = await tx
      .insert(portableMemoryItems)
      .values({ ownerUserId: userId, kind: "preference" })
      .returning({ id: portableMemoryItems.id });
    if (!item) throw new Error("probe: portable item insert returned nothing");
    await tx.insert(portableMemoryItemVersions).values({
      itemId: item.id,
      version: 1,
      statement: "Prefers short answers",
      actorKind: "user",
      actorUserId: userId,
    });
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runPortableMemoryItems).values({ teamId, runId, itemId: item.id, version: 1 });
  },
  run_site_memory_items: async (tx, teamId) => {
    const userId = await insertUser(tx);
    const [item] = await tx
      .insert(siteMemoryItems)
      .values({ kind: "convention", policy: true })
      .returning({ id: siteMemoryItems.id });
    if (!item) throw new Error("probe: site item insert returned nothing");
    await tx.insert(siteMemoryItemVersions).values({
      itemId: item.id,
      version: 1,
      statement: "Never share customer names",
      actorKind: "user",
      actorUserId: userId,
    });
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runSiteMemoryItems).values({ teamId, runId, itemId: item.id, version: 1 });
  },
  memory_stewards: async (tx, teamId) => {
    const userId = await insertUser(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "contributor" });
    await tx.insert(memoryStewards).values({ teamId, userId, grantedBy: userId });
  },
  memory_reminders: async (tx, teamId) => {
    const userId = await insertUser(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "team_admin" });
    await tx.insert(memoryReminders).values({
      teamId,
      objectId: randomUUID(),
      relatedKind: "memory.proposal.received",
      userId,
      dueAt: new Date(Date.now() + 7 * 86_400_000),
    });
  },
  memory_learning_passes: async (tx, teamId) => {
    await insertPass(tx, teamId);
  },
  memory_candidates: async (tx, teamId) => {
    const { passId } = await insertPass(tx, teamId);
    await tx
      .insert(memoryCandidates)
      .values({ teamId, passId, ord: 0, payload: { statement: "x" } });
  },
  memory_dismissals: async (tx, teamId) => {
    const { threadId, userId } = await insertThread(tx, teamId);
    await tx
      .insert(memoryDismissals)
      .values({ teamId, threadId, userId, statementHash: "0".repeat(64) });
  },
  memory_learning_watermarks: async (tx, teamId) => {
    const { threadId, userId } = await insertThread(tx, teamId);
    await tx.insert(memoryLearningWatermarks).values({ teamId, threadId, userId, entryId: "e1" });
  },
  memory_proposals: async (tx, teamId) => {
    const { passId, userId } = await insertPass(tx, teamId);
    const [candidate] = await tx
      .insert(memoryCandidates)
      .values({ teamId, passId, ord: 0, payload: { statement: "x" } })
      .returning({ id: memoryCandidates.id });
    if (!candidate) throw new Error("probe: candidate insert returned nothing");
    await tx.insert(memoryProposals).values({
      teamId,
      source: "candidate",
      candidateRef: candidate.id,
      statement: "Deploys go out on Tuesdays",
      kind: "convention",
      proposerId: userId,
    });
  },
  memory_project_suggestions: async (tx, teamId) => {
    const { passId, threadId, userId } = await insertPass(tx, teamId);
    const [candidate] = await tx
      .insert(memoryCandidates)
      .values({ teamId, passId, ord: 0, payload: { statement: "x" } })
      .returning({ id: memoryCandidates.id });
    if (!candidate) throw new Error("probe: candidate insert returned nothing");
    const [project] = await tx
      .insert(projects)
      .values({ teamId, name: "Probe", slug: `p-${randomUUID().slice(0, 8)}`, createdBy: userId })
      .returning({ id: projects.id });
    if (!project) throw new Error("probe: project insert returned nothing");
    await tx.insert(memoryProjectSuggestions).values({
      teamId,
      projectId: project.id,
      threadId,
      candidateRef: candidate.id,
      statement: "Invoices are numbered per year",
      kind: "convention",
      evidence: [{ entryId: "e1", quote: "we number invoices per year" }],
      suggestedBy: userId,
    });
  },
};
