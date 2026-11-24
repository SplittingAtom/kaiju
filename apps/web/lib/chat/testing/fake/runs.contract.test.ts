import {
  answerFeedbackSchema,
  evalCasePreviewSchema,
  kaijuEventSchema,
  myEvalCaseSchema,
  runStatusSchema,
  threadFeedbackSchema,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { FakeKaiju } from "../fake-kaiju";
import { call, expectContract } from "./contract";

/** A thread with one answered run: the run's events and its id. */
async function answered(fake: FakeKaiju) {
  const threadId = fake.addThread("T");
  const sent = await call(fake, "POST", `/v1/threads/${threadId}/messages`, { content: "Hi" });
  const runId = (sent.body as { run_id: string }).run_id;
  fake.agent.commitPrompt(runId);
  fake.agent.delta(runId, "m1", "Hello");
  fake.agent.toolCall(runId, "c1", "bash", { cmd: "ls" }, "m1");
  fake.agent.toolResult(runId, "c1", "bash", "a.md");
  fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "Hello" }] }, "m1");
  fake.agent.complete(runId, { epilogue: ["title"] });
  fake.agent.retitle(runId, "Greeting");
  fake.agent.suggest(runId, ["More?"]);
  return { threadId, runId };
}

describe("fake runs area: answers and events parse with the protocol (KOBE-717)", () => {
  it("streams events the protocol accepts", async () => {
    const fake = new FakeKaiju();
    const { runId } = await answered(fake);
    const events = fake.run(runId).events;
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) {
      expect(kaijuEventSchema.safeParse(event).error?.issues ?? [], event.type).toEqual([]);
    }
    const run = (await call(fake, "GET", `/v1/runs/${runId}`)).body as { status: unknown };
    expect(runStatusSchema.safeParse(run.status).success).toBe(true);
  });

  it("rates an answer, lists the ratings and shares an eval case", async () => {
    const fake = new FakeKaiju();
    const { threadId, runId } = await answered(fake);
    await expectContract(fake, answerFeedbackSchema, "PUT", `/v1/runs/${runId}/feedback`, {
      rating: "down",
      reasons: ["wrong"],
    });
    await expectContract(fake, threadFeedbackSchema, "GET", `/v1/threads/${threadId}/feedback`);
    const preview = await expectContract(
      fake,
      evalCasePreviewSchema,
      "POST",
      `/v1/runs/${runId}/eval-case/preview`,
      {},
    );
    await expectContract(fake, myEvalCaseSchema, "POST", `/v1/runs/${runId}/eval-case`, {
      digest: preview.digest,
    });
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKaiju();
    const { runId } = await answered(fake);
    const { body } = await call(fake, "PUT", `/v1/runs/${runId}/feedback`, { rating: "up" });
    expect(answerFeedbackSchema.safeParse({ ...(body as object), rating: 1 }).success).toBe(false);
  });
});
