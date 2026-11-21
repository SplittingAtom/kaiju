import {
  commitFromProposalResponseSchema,
  projectFileSchema,
  projectFilesResponseSchema,
  projectHistoryResponseSchema,
  projectListResponseSchema,
  projectSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

describe("fake projects area: answers parse with the protocol (KOBE-717)", () => {
  it("lists projects, their files and history; imports; commits a proposal", async () => {
    const fake = new FakeKobe();
    const id = fake.addProject("Budget");
    fake.projectFiles.set(id, ["plan.md"]);
    fake.projectHeads.set(id, { seq: 2, files: new Map([["plan.md", "x"]]) });
    await expectContract(fake, projectListResponseSchema, "GET", "/v1/projects");
    await expectContract(fake, projectFilesResponseSchema, "GET", `/v1/projects/${id}/files`);
    await expectContract(fake, projectFileSchema, "POST", `/v1/projects/${id}/files/import`, {
      name: "notes.md",
      folder: "",
    });
    await expectContract(fake, projectHistoryResponseSchema, "GET", `/v1/projects/${id}/commits`);
    await expectContract(
      fake,
      commitFromProposalResponseSchema,
      "POST",
      `/v1/projects/${id}/commits/from-proposal`,
      {},
    );
    await expectContract(fake, projectSchema, "POST", "/v1/projects/from-folder", {
      name: "Hiring",
    });
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKobe();
    fake.addProject("Budget");
    const { body } = await call(fake, "GET", "/v1/projects");
    const list = body as { projects: Record<string, unknown>[] };
    const projects = list.projects.map((p) => ({ ...p, my_role: "admin" }));
    expect(projectListResponseSchema.safeParse({ projects }).success).toBe(false);
  });
});
