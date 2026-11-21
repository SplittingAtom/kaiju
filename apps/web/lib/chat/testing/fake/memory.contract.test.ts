import { memoryDocDetailSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

const DOC = "00000000-0000-4000-8000-000000000123";

describe("fake memory area: answers parse with the protocol (KOBE-717)", () => {
  it("restores a memory document", async () => {
    const fake = new FakeKobe();
    await expectContract(fake, memoryDocDetailSchema, "POST", `/v1/memory/${DOC}/restore`, {
      version: 2,
    });
  });

  it("fails on a deliberate drift", async () => {
    const { body } = await call(new FakeKobe(), "POST", `/v1/memory/${DOC}/restore`, {});
    expect(
      memoryDocDetailSchema.safeParse({ ...(body as object), scope: "everyone" }).success,
    ).toBe(false);
  });
});
