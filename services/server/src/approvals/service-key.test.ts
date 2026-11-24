import type { KaijuDb } from "@kaiju/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { SCHEDULER_APPROVALS } from "../startup/server-deps.js";
import { ApprovalService } from "./service.js";

/**
 * KOBE-817: the scheduler process never decides or signs an approval, so it neither needs
 * KOBE_APPROVAL_KEY nor logs an error about it; the server process still does both.
 */

const db = {} as KaijuDb;
const logger = () =>
  ({ error: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn> };

describe("the approval key's startup log (KOBE-817)", () => {
  it("logs an error on a server process without the key", () => {
    const log = logger();
    new ApprovalService({ db, log });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("KOBE_APPROVAL_KEY is not set"));
  });

  it("logs nothing in the scheduler process, which serves no approvals", () => {
    const log = logger();
    new ApprovalService({ db, log, ...SCHEDULER_APPROVALS });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("still denies approvals without a key (no bypass)", async () => {
    const service = new ApprovalService({ db, log: logger(), ...SCHEDULER_APPROVALS });
    const outcome = await service.broker.request(
      {
        decision: { reasons: [] },
        input: {},
        signal: new AbortController().signal,
      } as never,
      () => undefined,
    );
    expect(outcome.decision).toBe("deny");
    expect(service.configured).toBe(false);
  });
});

describe("the scheduler cannot reach an approval decision (KOBE-817)", () => {
  it("serves no approval routes: its app is built without deps", async () => {
    // startListeners passes deps to createApp only when config.process is "server".
    const app = createApp(undefined);
    for (const path of ["/v1/approvals", "/v1/approvals/x"]) {
      const res = await app.request(path, { method: path.endsWith("x") ? "POST" : "GET" });
      expect(res.status).toBe(404);
    }
  });
});
