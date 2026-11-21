import { artifactDetailSchema, artifactListResponseSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

describe("fake artifacts area: answers parse with the protocol (KOBE-717)", () => {
  it("lists a thread's artifacts and reads one", async () => {
    const fake = new FakeKobe();
    const threadId = fake.addThread("T");
    const id = fake.addArtifact(threadId, {
      kind: "markdown",
      title: "Notes",
      versions: ["a", "b"],
    });
    await expectContract(
      fake,
      artifactListResponseSchema,
      "GET",
      `/v1/artifacts?thread_id=${threadId}`,
    );
    await expectContract(fake, artifactDetailSchema, "GET", `/v1/artifacts/${id}`);
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKobe();
    const id = fake.addArtifact(fake.addThread(), {
      kind: "markdown",
      title: "N",
      versions: ["a"],
    });
    const { body } = await call(fake, "GET", `/v1/artifacts/${id}`);
    expect(artifactDetailSchema.safeParse({ ...(body as object), extra: true }).success).toBe(
      false,
    );
  });
});
