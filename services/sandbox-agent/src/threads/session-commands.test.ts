import { describe, expect, it } from "vitest";
import type { ManagerPort } from "./manager-options.js";
import { runPiCommand } from "./session-commands.js";
import type { Thread } from "./thread.js";

/** KOBE-733: nothing starts a Pi while the sandbox drains for its reclaim proof. */
describe("pi.command while draining", () => {
  it("is refused before it can start a Pi", async () => {
    let started = false;
    const port = {
      draining: () => true,
      ensureProcess: () => {
        started = true;
        return Promise.resolve(undefined);
      },
    } as unknown as ManagerPort;
    const thread = { id: "t", restoring: false, compacting: false } as unknown as Thread;
    const out = await runPiCommand(port, thread, {
      type: "pi.command",
      thread_id: "t",
      command: { id: "srv", type: "get_state" },
    } as never);
    expect(out).toMatchObject({ ok: false, code: "pi_unavailable" });
    expect(started).toBe(false);
  });
});
