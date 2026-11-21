import {
  branchSummaryResponseSchema,
  compactThreadResponseSchema,
  forkThreadResponseSchema,
  learnStartResponseSchema,
  learnStateSchema,
  threadBranchesResponseSchema,
  threadContextMemoriesSchema,
  threadFileLinksResponseSchema,
  threadFileLinksSchema,
  threadFilesResponseSchema,
  threadFolderSchema,
  threadFoldersResponseSchema,
  threadLineageResponseSchema,
  threadSyncConflictsResponseSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

/** A thread with two prompts and an answer: its id and entry ids. */
function seeded(fake: FakeKobe) {
  const threadId = fake.addThread("Budget");
  const root = fake.addSystemEntry(threadId, null, "model_change", {
    provider: "kobe",
    modelId: "k2",
  });
  const prompt = fake.addEntry(threadId, root, { role: "user", content: "Plan it" });
  const answer = fake.addEntry(threadId, prompt, {
    role: "assistant",
    content: [{ type: "text", text: "Here." }],
  });
  return { threadId, root, prompt, answer };
}

describe("fake threads area: answers parse with the protocol (KOBE-717)", () => {
  it("lineage, branches, labels, fork", async () => {
    const fake = new FakeKobe();
    const { threadId, answer } = seeded(fake);
    const at = `/v1/threads/${threadId}`;
    await expectContract(fake, threadBranchesResponseSchema, "GET", `${at}/branches`);
    await expectContract(fake, threadBranchesResponseSchema, "PUT", `${at}/labels/${answer}`, {
      label: "Short",
    });
    const fork = await expectContract(fake, forkThreadResponseSchema, "POST", `${at}/fork`, {
      entry_id: answer,
    });
    await expectContract(
      fake,
      threadLineageResponseSchema,
      "GET",
      `/v1/threads/${fork.thread_id}/lineage`,
    );
    await expectContract(fake, threadLineageResponseSchema, "GET", `${at}/lineage`);
  });

  it("Compact now and a carried branch summary", async () => {
    const fake = new FakeKobe();
    const { threadId, prompt } = seeded(fake);
    const at = `/v1/threads/${threadId}`;
    await expectContract(fake, compactThreadResponseSchema, "POST", `${at}/compact`, {
      focus: "costs",
    });
    await expectContract(fake, branchSummaryResponseSchema, "POST", `${at}/branch-summary`, {
      to_entry_id: prompt,
    });
  });

  it("context memories, Learn, files, conflicts and file links", async () => {
    const fake = new FakeKobe();
    const { threadId } = seeded(fake);
    const at = `/v1/threads/${threadId}`;
    fake.learnState.set(threadId, { blocker: null });
    fake.fileLinks.link(threadId, { path: "plan.md", access: "write" });
    await expectContract(fake, threadContextMemoriesSchema, "GET", `${at}/context/memories`);
    await expectContract(fake, learnStateSchema, "GET", `${at}/learn`);
    await expectContract(fake, learnStartResponseSchema, "POST", `${at}/learn`, { mode: "new" });
    await expectContract(fake, threadFilesResponseSchema, "GET", `${at}/files`);
    await expectContract(fake, threadSyncConflictsResponseSchema, "GET", `${at}/sync-conflicts`);
    await expectContract(fake, threadFileLinksSchema, "GET", `${at}/file-links`);
    await expectContract(
      fake,
      threadFileLinksResponseSchema,
      "GET",
      `/v1/threads/file-links?threads=${threadId}`,
    );
  });

  it("folders", async () => {
    const fake = new FakeKobe();
    const folder = await expectContract(fake, threadFolderSchema, "POST", "/v1/thread-folders", {
      name: "Q4",
      parent_id: null,
    });
    await expectContract(fake, threadFolderSchema, "PATCH", `/v1/thread-folders/${folder.id}`, {
      name: "Q1",
    });
    await expectContract(fake, threadFoldersResponseSchema, "GET", "/v1/thread-folders");
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKobe();
    const { threadId } = seeded(fake);
    const { body } = await call(fake, "GET", `/v1/threads/${threadId}/lineage`);
    const { root_hidden: _hidden, ...drifted } = body as Record<string, unknown>;
    expect(threadLineageResponseSchema.safeParse(drifted).success).toBe(false);
  });
});
