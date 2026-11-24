import {
  approvalStatusSchema,
  approveAllBodySchema,
  kaijuEventSchema,
  rememberScopeSchema,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { FakeKaiju } from "../fake-kaiju";
import { call } from "./contract";

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";

async function waiting(fake: FakeKaiju) {
  const threadId = fake.addThread("T");
  const sent = await call(fake, "POST", `/v1/threads/${threadId}/messages`, { content: "Go" });
  const runId = (sent.body as { run_id: string }).run_id;
  for (const [id, call_] of [
    [A1, "c1"],
    [A2, "c2"],
  ] as const) {
    fake.requestApproval(runId, {
      approval_id: id,
      tool_call_id: call_,
      tool: "write_file",
      input: { path: "a.md" },
      risk: "write",
      reasons: [{ code: "risk_write", stage: "risk_class", message: "Changes files." }],
      expires_at: "2026-10-02T11:00:00.000Z",
    });
  }
  return runId;
}

describe("fake approvals area: answers parse with the protocol (KOBE-717)", () => {
  it("asks, offers remembering and resolves through events the protocol accepts", async () => {
    const fake = new FakeKaiju();
    const runId = await waiting(fake);
    const view = (await call(fake, "GET", `/v1/approvals/${A1}`)).body as { status: unknown };
    expect(approvalStatusSchema.safeParse(view.status).success).toBe(true);
    const offer = (await call(fake, "GET", `/v1/approvals/${A1}/remember`)).body as {
      choices: { scope: unknown }[];
      approve_all: { approval_ids: string[] } | null;
    };
    for (const c of offer.choices)
      expect(rememberScopeSchema.safeParse(c.scope).success).toBe(true);
    const body = { run_id: runId, approval_ids: offer.approve_all?.approval_ids ?? [] };
    expect(approveAllBodySchema.safeParse(body).error?.issues ?? []).toEqual([]);
    expect((await call(fake, "POST", "/v1/approvals/approve-all", body)).status).toBe(200);
    for (const event of fake.run(runId).events) {
      expect(kaijuEventSchema.safeParse(event).error?.issues ?? [], event.type).toEqual([]);
    }
  });

  it("fails on a deliberate drift", () => {
    expect(approvalStatusSchema.safeParse("approved").success).toBe(false);
  });
});
