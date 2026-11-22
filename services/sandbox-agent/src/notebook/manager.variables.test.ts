import { randomUUID } from "node:crypto";
import { notebookExecuteResultSchema } from "@kobe/protocol";
import type { NotebookExecuteFrame } from "@kobe/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import { KernelManager } from "./manager.js";
import { fakeLauncher } from "./testing/fake-bridge.js";
import { INSPECT_LIMITS } from "./variables.js";
import { until } from "../testing/until.js";

/** KOBE-803: run timing, the snapshot after a run, and `notebook.inspect` on the manager. */
const T1 = randomUUID();
const RUN = randomUUID();

function setup() {
  const { launch, control } = fakeLauncher();
  const logs: string[] = [];
  const manager = new KernelManager({
    launch,
    maxKernels: 2,
    idleMs: 60_000,
    graceMs: 50,
    readyTimeoutMs: 200,
    log: (m) => logs.push(m),
  });
  return { manager, control, logs };
}

function frame(code: string, extra: Partial<NotebookExecuteFrame> = {}): NotebookExecuteFrame {
  return {
    v: 1,
    type: "notebook.execute",
    command_id: randomUUID(),
    thread_id: T1,
    run_id: RUN,
    exec_id: randomUUID(),
    code,
    timeout_ms: 10_000,
    ...extra,
  };
}

const exec = (m: KernelManager, f: NotebookExecuteFrame) => m.execute(f, () => undefined);
const data = (o: { ok: boolean; data?: unknown }) => {
  if (!o.ok) throw new Error("command failed");
  return o.data as Record<string, unknown>;
};

describe("run timing (KOBE-803)", () => {
  it("is reported only when asked, with ordered instants and a whole duration", async () => {
    const { manager } = setup();
    const plain = data(await exec(manager, frame("print:a")));
    expect(plain).toEqual({ status: "ok", execution_count: 1, outputs: 1, truncated: false });
    const timed = data(await exec(manager, frame("print:b", { with_timing: true })));
    expect(notebookExecuteResultSchema.safeParse(timed).success).toBe(true);
    const timing = timed.timing as { started_at: string; finished_at: string; duration_ms: number };
    expect(Number.isInteger(timing.duration_ms)).toBe(true);
    expect(Date.parse(timing.finished_at)).toBeGreaterThanOrEqual(Date.parse(timing.started_at));
    await manager.stopAll();
  });

  it("is absent for a cell that never ran", async () => {
    const { manager, control } = setup();
    const running = exec(manager, frame("sleep"));
    const waiting = exec(manager, frame("print:x", { with_timing: true }));
    await until(() => control.executed.length === 1);
    manager.interrupt(T1);
    await running;
    const dropped = data(await waiting);
    expect(dropped.status).toBe("interrupted");
    expect(dropped.timing).toBeUndefined();
    await manager.stopAll();
  });
});

describe("the snapshot after a run (KOBE-803)", () => {
  it("rides on the result when asked, and never bumps the execution count", async () => {
    const { manager, control } = setup();
    const first = data(await exec(manager, frame("print:a", { with_variables: true })));
    expect(first.variables).toMatchObject({
      status: "ok",
      execution_count: 1,
      variables: [{ name: "x", type: "int", repr: "1" }],
      other: [{ name: "np", kind: "module" }],
      truncated: false,
    });
    expect(notebookExecuteResultSchema.safeParse(first).success).toBe(true);
    expect(control.inspected).toEqual([`${T1}:${JSON.stringify(INSPECT_LIMITS)}`]);
    const second = data(await exec(manager, frame("print:b")));
    expect(second.execution_count).toBe(2);
    expect(second.variables).toBeUndefined();
    await manager.stopAll();
  });

  it("follows an error too, but not a timeout or a lost kernel", async () => {
    const { manager, control } = setup();
    const failed = data(await exec(manager, frame("fail", { with_variables: true })));
    expect(failed.status).toBe("error");
    expect(failed.variables).toMatchObject({ status: "ok" });
    const timedOut = data(
      await exec(manager, frame("sleep", { with_variables: true, timeout_ms: 1000 })),
    );
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.variables).toBeUndefined();
    const died = data(await exec(manager, frame("die", { with_variables: true })));
    expect(died.variables).toBeUndefined();
    expect(control.inspected).toHaveLength(1);
    await manager.stopAll();
  });

  it("an unreadable snapshot is unavailable, the result still stands", async () => {
    const { manager, control, logs } = setup();
    control.inspectMode = "malformed";
    const r = data(await exec(manager, frame("print:a", { with_variables: true })));
    expect(r).toMatchObject({ status: "ok", variables: { status: "unavailable" } });
    expect(logs).toContain("variables snapshot malformed");
    await manager.stopAll();
  });
});

describe("notebook.inspect on the manager (KOBE-803)", () => {
  it("never starts a kernel: no_kernel", async () => {
    const { manager, control } = setup();
    expect(await manager.inspect(T1, 1000)).toEqual({ ok: true, data: { status: "no_kernel" } });
    expect(control.launched).toEqual([]);
  });

  it("answers the live kernel's snapshot", async () => {
    const { manager } = setup();
    await exec(manager, frame("print:a"));
    const snap = data(await manager.inspect(T1, 1000));
    expect(snap).toMatchObject({ status: "ok", execution_count: 1, truncated: false });
    expect(typeof snap.taken_at).toBe("string");
    await manager.stopAll();
  });

  it("is busy while a cell runs or waits", async () => {
    const { manager, control } = setup();
    const running = exec(manager, frame("sleep"));
    await until(() => control.executed.length === 1);
    expect(await manager.inspect(T1, 1000)).toEqual({ ok: true, data: { status: "busy" } });
    manager.interrupt(T1);
    await running;
    expect(control.inspected).toEqual([]);
    await manager.stopAll();
  });

  it("a failed introspection is unavailable", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    control.inspectMode = "fail";
    expect(await manager.inspect(T1, 1000)).toEqual({ ok: true, data: { status: "unavailable" } });
    await manager.stopAll();
  });

  it("times out as unavailable, interrupts the snapshot, and the next cell waits for its end", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    control.inspectMode = "hang";
    expect(await manager.inspect(T1, 50)).toEqual({ ok: true, data: { status: "unavailable" } });
    expect(control.interrupts).toEqual([T1]);
    control.inspectMode = "ok";
    const next = data(await exec(manager, frame("print:b")));
    expect(next).toMatchObject({ status: "ok", execution_count: 2 });
    await manager.stopAll();
  });

  it("a snapshot stuck past interrupts holds the kernel until it is restarted", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    control.inspectMode = "stuck";
    expect(await manager.inspect(T1, 50)).toEqual({ ok: true, data: { status: "unavailable" } });
    expect(await manager.inspect(T1, 50)).toEqual({ ok: true, data: { status: "busy" } });
    let settled = false;
    const next = exec(manager, frame("print:b")).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(control.executed).toEqual([`${T1}:print:a`]);
    await manager.restart(T1);
    expect(data(await next).status).toBe("restarted");
    control.inspectMode = "ok";
    expect(data(await exec(manager, frame("print:c")))).toMatchObject({ status: "ok" });
    await manager.stopAll();
  });
});
