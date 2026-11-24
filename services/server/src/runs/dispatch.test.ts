import pino from "pino";
import { describe, expect, it } from "vitest";
import type { KaijuDb } from "@kaiju/db";
import type { SandboxRouter } from "../sandbox-wire/types.js";
import { RunDispatcher, type DispatchHost } from "./dispatch.js";
import type { StartPlan } from "./lifecycle.js";

const plan = {
  teamId: "team",
  runId: "run",
  threadId: "thread",
  ownerUserId: "owner",
  input: "where do I park?",
  parentEntryId: null,
  approvalMode: "ask-on-write",
  agent: null,
} as unknown as StartPlan;

describe("run start dispatch", () => {
  it("starts the query embedding before run.start goes to the sandbox (KOBE-409 review M1)", async () => {
    const order: string[] = [];
    const router = {
      startRun: async () => {
        order.push("run.start");
        return { ok: true, data: {} };
      },
    } as unknown as SandboxRouter;
    const host = {
      db: undefined as unknown as KaijuDb,
      router,
      log: pino({ level: "silent" }),
      closed: () => false,
      prefetchQuery: (q: unknown) => order.push(`embed ${JSON.stringify(q)}`),
    } as unknown as DispatchHost;
    await new RunDispatcher(host).start(plan);
    expect(order).toEqual([
      `embed ${JSON.stringify({
        teamId: "team",
        userId: "owner",
        threadId: "thread",
        runId: "run",
        message: "where do I park?",
      })}`,
      "run.start",
    ]);
  });
});
