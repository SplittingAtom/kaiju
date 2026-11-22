import { randomUUID } from "node:crypto";
import { CAPABILITY_NOTEBOOK_INSPECT, CAPABILITY_NOTEBOOKS } from "@kobe/protocol";
import type { ServerToSandboxFrame } from "@kobe/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import type { CommandRow } from "../commands.js";
import type { DeliveryEnv } from "./env.js";
import { frameFor, withMemberRunAsks, withNotebookAsks } from "./frames.js";
import { deliveryRefusal } from "./preflight.js";

/**
 * KOBE-803 at delivery: `notebook.inspect` reaches only the member's own sandbox, only an agent
 * with `notebooks` and `notebook_inspect`; `notebook.execute`'s timing and snapshot asks are
 * dropped for agents without `notebook_inspect` (their strict decoder would refuse the frame).
 */
const THREAD = randomUUID();
const RUN = randomUUID();

function env(capabilities: readonly string[], evalThreadId?: string): DeliveryEnv {
  return {
    ctx: {},
    host: {
      target: { teamId: randomUUID(), userId: randomUUID(), evalThreadId },
      hasCapability: (name: string) => capabilities.includes(name),
    },
  } as unknown as DeliveryEnv;
}

const inspectRow: CommandRow = {
  id: randomUUID(),
  kind: "notebook.inspect",
  threadId: THREAD,
  runId: null,
  frame: { thread_id: THREAD, timeout_ms: 5000 },
  requesterReplica: "r1",
};

describe("notebook.inspect delivery (KOBE-803)", () => {
  it("is a valid stored frame", () => {
    expect(frameFor(inspectRow, "c1")).toEqual({
      v: 1,
      type: "notebook.inspect",
      command_id: "c1",
      thread_id: THREAD,
      timeout_ms: 5000,
    });
  });

  it("goes to an agent with notebooks and notebook_inspect only, never an eval sandbox", () => {
    const frame = { thread_id: THREAD };
    expect(
      deliveryRefusal(env([CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT]), inspectRow, frame),
    ).toBeUndefined();
    expect(deliveryRefusal(env([CAPABILITY_NOTEBOOKS]), inspectRow, frame)?.outcome).toMatchObject({
      ok: false,
      error: { code: "inspect_unsupported" },
    });
    expect(
      deliveryRefusal(env([CAPABILITY_NOTEBOOK_INSPECT]), inspectRow, frame)?.outcome,
    ).toMatchObject({ ok: false, error: { code: "notebooks_unsupported" } });
    const evalSandbox = env([CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT], THREAD);
    expect(deliveryRefusal(evalSandbox, inspectRow, frame)?.outcome).toMatchObject({
      ok: false,
      error: { code: "notebooks_unsupported" },
    });
    expect(deliveryRefusal(evalSandbox, inspectRow, frame)?.endsRun).toBe(false);
  });
});

describe("notebook.execute asks (KOBE-803)", () => {
  const execute: ServerToSandboxFrame = {
    v: 1,
    type: "notebook.execute",
    command_id: "c2",
    thread_id: THREAD,
    run_id: RUN,
    exec_id: randomUUID(),
    code: "1",
    timeout_ms: 1000,
    with_timing: true,
    with_variables: true,
  };

  it("keeps them for agents with notebook_inspect and drops them for the rest", () => {
    const has = (caps: string[]) => (name: string) => caps.includes(name);
    expect(withNotebookAsks(execute, has([CAPABILITY_NOTEBOOK_INSPECT]))).toEqual(execute);
    const old = withNotebookAsks(execute, has([CAPABILITY_NOTEBOOKS]));
    expect(old).not.toHaveProperty("with_timing");
    expect(old).not.toHaveProperty("with_variables");
    expect(old).toMatchObject({ type: "notebook.execute", code: "1" });
    const other: ServerToSandboxFrame = {
      v: 1,
      type: "notebook.interrupt",
      command_id: "c3",
      thread_id: THREAD,
    };
    expect(withNotebookAsks(other, has([]))).toBe(other);
  });

  it("a stored member's run gets both asks at delivery, only from a capable agent", () => {
    const has = (caps: string[]) => (name: string) => caps.includes(name);
    const {
      with_timing: _t,
      with_variables: _v,
      ...stored
    } = execute as Extract<ServerToSandboxFrame, { type: "notebook.execute" }>;
    expect(withMemberRunAsks(stored, has([CAPABILITY_NOTEBOOK_INSPECT]))).toEqual(execute);
    const old = withMemberRunAsks(stored, has([CAPABILITY_NOTEBOOKS]));
    expect(old).not.toHaveProperty("with_timing");
    expect(old).not.toHaveProperty("with_variables");
  });

  it("a stored notebook.execute row carries no asks (an older replica must still read it)", () => {
    const row: CommandRow = {
      id: randomUUID(),
      kind: "notebook.execute",
      threadId: THREAD,
      runId: RUN,
      frame: { thread_id: THREAD, run_id: RUN, exec_id: randomUUID(), code: "1", timeout_ms: 1000 },
      requesterReplica: "r1",
    };
    expect(frameFor(row, "c4")).not.toHaveProperty("with_variables");
  });
});
