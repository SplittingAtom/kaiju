import { appCardEntrySchema, launchAppCardResponseSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

const APP = {
  appId: "a".repeat(64),
  connectorId: "00000000-0000-4000-8000-0000000000c1",
  connectorName: "Lake",
  tool: "explore",
  sha256: "b".repeat(64),
  title: "Lakehouse explorer",
};

describe("fake apps area: answers parse with the protocol (KOBE-717)", () => {
  it("launches an app card into a thread, waiting during a run, and stores its entry", async () => {
    const fake = new FakeKobe();
    fake.teamApps = [APP];
    const threadId = fake.addThread("T");
    await expectContract(
      fake,
      launchAppCardResponseSchema,
      "POST",
      `/v1/threads/${threadId}/app-cards`,
      {
        app_id: APP.appId,
      },
    );
    const entry = fake.threads.get(threadId)?.entries.at(-1)?.payload;
    expect(appCardEntrySchema.safeParse(entry).error?.issues ?? []).toEqual([]);
    await call(fake, "POST", `/v1/threads/${threadId}/messages`, { content: "Go" });
    await expectContract(
      fake,
      launchAppCardResponseSchema,
      "POST",
      `/v1/threads/${threadId}/app-cards`,
      {
        app_id: APP.appId,
      },
    );
    await expectContract(fake, launchAppCardResponseSchema, "POST", "/v1/threads/app-cards", {
      app_id: APP.appId,
    });
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKobe();
    fake.teamApps = [APP];
    const threadId = fake.addThread("T");
    const { body } = await call(fake, "POST", `/v1/threads/${threadId}/app-cards`, {
      app_id: APP.appId,
    });
    expect(
      launchAppCardResponseSchema.safeParse({ ...(body as object), queued: "no" }).success,
    ).toBe(false);
  });
});
