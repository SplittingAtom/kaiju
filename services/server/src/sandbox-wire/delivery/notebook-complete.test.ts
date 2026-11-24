import { randomUUID } from "node:crypto";
import {
  CAPABILITY_NOTEBOOK_COMPLETE,
  CAPABILITY_NOTEBOOK_INSPECT,
  CAPABILITY_NOTEBOOKS,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import type { CommandRow } from "../commands.js";
import type { DeliveryEnv } from "./env.js";
import { frameFor } from "./frames.js";
import { deliveryRefusal } from "./preflight.js";

/**
 * KOBE-808 at delivery: a completion `notebook.inspect` (with `op`) reaches only the member's own
 * sandbox, only an agent with `notebooks` and `notebook_complete`; a variables snapshot still
 * needs only `notebook_inspect`.
 */
const THREAD = randomUUID();
const ALL = [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT, CAPABILITY_NOTEBOOK_COMPLETE];

function env(capabilities: readonly string[], evalThreadId?: string): DeliveryEnv {
  return {
    ctx: {},
    host: {
      target: { teamId: randomUUID(), userId: randomUUID(), evalThreadId },
      hasCapability: (name: string) => capabilities.includes(name),
    },
  } as unknown as DeliveryEnv;
}

const row = (frame: Record<string, unknown>): CommandRow => ({
  id: randomUUID(),
  kind: "notebook.inspect",
  threadId: THREAD,
  runId: null,
  frame: { thread_id: THREAD, timeout_ms: 1000, ...frame },
  requesterReplica: "r1",
});

const completeRow = row({ op: "complete", code: "df.", cursor: 3 });
const docRow = row({ op: "doc", name: "df.head" });

describe("kernel completion delivery (KOBE-808)", () => {
  it("is a valid stored frame, for both ops; a stored frame with code but no op is not", () => {
    expect(frameFor(completeRow, "c1")).toEqual({
      v: 1,
      type: "notebook.inspect",
      command_id: "c1",
      thread_id: THREAD,
      timeout_ms: 1000,
      op: "complete",
      code: "df.",
      cursor: 3,
    });
    expect(frameFor(docRow, "c2")).toMatchObject({ op: "doc", name: "df.head" });
    expect(frameFor(row({ code: "x", cursor: 1 }), "c3")).toBeUndefined();
  });

  it("goes to an agent with notebooks and notebook_complete only, never an eval sandbox", () => {
    for (const r of [completeRow, docRow]) {
      expect(deliveryRefusal(env(ALL), r, r.frame)).toBeUndefined();
      expect(
        deliveryRefusal(env([CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT]), r, r.frame)
          ?.outcome,
      ).toMatchObject({ ok: false, error: { code: "complete_unsupported" } });
      expect(
        deliveryRefusal(env([CAPABILITY_NOTEBOOK_COMPLETE]), r, r.frame)?.outcome,
      ).toMatchObject({ ok: false, error: { code: "notebooks_unsupported" } });
      const evalSandbox = deliveryRefusal(env(ALL, THREAD), r, r.frame);
      expect(evalSandbox?.outcome).toMatchObject({ error: { code: "notebooks_unsupported" } });
      expect(evalSandbox?.endsRun).toBe(false);
    }
    // A snapshot is not held back by the new capability.
    const snapshot = row({});
    expect(
      deliveryRefusal(env([CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT]), snapshot, {}),
    ).toBeUndefined();
  });
});
