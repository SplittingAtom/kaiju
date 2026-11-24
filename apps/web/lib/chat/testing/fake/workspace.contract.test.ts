import {
  fileThreadsResponseSchema,
  workspaceFileEntrySchema,
  workspaceListResponseSchema,
  workspaceSearchResponseSchema,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { FakeKaiju } from "../fake-kaiju";
import { call, expectContract } from "./contract";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("fake workspace area: answers parse with the protocol (KOBE-717)", () => {
  it("lists, searches, saves and names a file's threads", async () => {
    const fake = new FakeKaiju();
    fake.workspaceFiles.set("report.md", bytes("# Report"));
    fake.workspaceFiles.set("data/sales.csv", bytes("a,b"));
    fake.workspaceDirs.add("data");
    await expectContract(fake, workspaceListResponseSchema, "GET", "/v1/workspace/files?path=");
    await expectContract(fake, workspaceListResponseSchema, "GET", "/v1/workspace/files?path=data");
    await expectContract(
      fake,
      workspaceSearchResponseSchema,
      "GET",
      "/v1/workspace/files/search?q=re",
    );
    const res = await fake.fetch("/v1/workspace/file?path=new.md", {
      method: "PUT",
      body: bytes("hi"),
    });
    expect(workspaceFileEntrySchema.safeParse(await res.json()).error?.issues ?? []).toEqual([]);
    const threadId = fake.addThread("Uses it");
    fake.fileLinks.link(threadId, { path: "report.md", access: "write" });
    await expectContract(
      fake,
      fileThreadsResponseSchema,
      "GET",
      "/v1/workspace/file-threads?paths=report.md",
    );
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKaiju();
    fake.workspaceFiles.set("a.md", bytes("a"));
    const { body } = await call(fake, "GET", "/v1/workspace/files?path=");
    const listing = body as { entries: Record<string, unknown>[] };
    const entries = listing.entries.map(({ size_bytes: size, ...e }) => ({ ...e, size }));
    expect(workspaceListResponseSchema.safeParse({ ...listing, entries }).success).toBe(false);
  });
});
