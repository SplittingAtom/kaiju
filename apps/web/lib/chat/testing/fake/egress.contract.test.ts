import { threadEgressBlockedResponseSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FakeKobe } from "../fake-kobe";
import { call, expectContract } from "./contract";

async function blocked(fake: FakeKobe) {
  const threadId = fake.addThread("T");
  const sent = await call(fake, "POST", `/v1/threads/${threadId}/messages`, { content: "Fetch" });
  const runId = (sent.body as { run_id: string }).run_id;
  fake.agent.commitPrompt(runId);
  fake.emit(runId, "egress.blocked", {
    domain: "example.com",
    tool_call_id: "c1",
    request_access: true,
    reason: "not_enabled",
  });
  return threadId;
}

describe("fake egress area: answers parse with the protocol (KOBE-717)", () => {
  it("lists a thread's blocked domains", async () => {
    const fake = new FakeKobe();
    const threadId = await blocked(fake);
    await expectContract(
      fake,
      threadEgressBlockedResponseSchema,
      "GET",
      `/v1/threads/${threadId}/egress-blocked`,
    );
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKobe();
    const threadId = await blocked(fake);
    const { body } = await call(fake, "GET", `/v1/threads/${threadId}/egress-blocked`);
    const rows = (body as { blocked: Record<string, unknown>[] }).blocked;
    const drifted = { blocked: rows.map((r) => ({ ...r, seq: 0 })) };
    expect(threadEgressBlockedResponseSchema.safeParse(drifted).success).toBe(false);
  });
});
