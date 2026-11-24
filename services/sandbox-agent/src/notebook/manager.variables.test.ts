import { randomUUID } from "node:crypto";
import { notebookExecuteResultSchema } from "@kaiju/protocol";
import type { NotebookExecuteFrame } from "@kaiju/protocol/sandbox-wire";
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
    afterRunInspectMs: 100,
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

describe("the snapshot after a member's run (KOBE-803)", () => {
  it("is kept for notebook.inspect, never returned, and never bumps the execution count", async () => {
    const { manager, control } = setup();
    const first = data(await exec(manager, frame("print:a", { with_variables: true })));
    expect(first).toEqual({ status: "ok", execution_count: 1, outputs: 1, truncated: false });
    expect(notebookExecuteResultSchema.safeParse(first).success).toBe(true);
    expect(control.inspected).toEqual([`${T1}:${JSON.stringify(INSPECT_LIMITS)}`]);
    // Nothing ran since: the kept snapshot, current, without asking the kernel again.
    const kept = data(await manager.inspect(T1, 1000));
    expect(kept).toMatchObject({
      status: "ok",
      execution_count: 1,
      stale: false,
      variables: [{ name: "x", type: "int", repr: "1" }],
      other: [{ name: "np", kind: "module" }],
    });
    expect(control.inspected).toHaveLength(1);
    // A refresh asks the kernel.
    expect(data(await manager.inspect(T1, 1000, true))).toMatchObject({ stale: false });
    expect(control.inspected).toHaveLength(2);
    expect(data(await exec(manager, frame("print:b"))).execution_count).toBe(2);
    await manager.stopAll();
  });

  it("is not taken without with_variables (the agent's run_python), nor after a timeout", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    const timedOut = data(
      await exec(manager, frame("sleep", { with_variables: true, timeout_ms: 1000 })),
    );
    expect(timedOut.status).toBe("timeout");
    expect(control.inspected).toEqual([]);
    await manager.stopAll();
  });

  it("is answered stale while code runs, and replaced by a fresh one once code ran since", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a", { with_variables: true }));
    const running = exec(manager, frame("sleep"));
    await until(() => control.executed.length === 2);
    expect(data(await manager.inspect(T1, 1000))).toMatchObject({
      status: "ok",
      execution_count: 1,
      stale: true,
    });
    manager.interrupt(T1);
    await running;
    expect(control.inspected).toHaveLength(1);
    // Code ran since (the agent's run took no snapshot): a fresh one is taken when idle.
    await exec(manager, frame("print:b"));
    const fresh = data(await manager.inspect(T1, 1000));
    expect(fresh).toMatchObject({ stale: false, execution_count: 2 });
    expect(control.inspected).toHaveLength(2);
    await manager.stopAll();
  });

  it("an unreadable snapshot keeps nothing; the run's result still stands", async () => {
    const { manager, control, logs } = setup();
    control.inspectMode = "malformed";
    const r = data(await exec(manager, frame("print:a", { with_variables: true })));
    expect(r).toEqual({ status: "ok", execution_count: 1, outputs: 1, truncated: false });
    expect(logs).toContain("variables snapshot malformed");
    expect(data(await manager.inspect(T1, 1000))).toEqual({ status: "unavailable" });
    await manager.stopAll();
  });

  it("goes with the kernel on restart", async () => {
    const { manager } = setup();
    await exec(manager, frame("print:a", { with_variables: true }));
    await manager.restart(T1);
    expect(data(await manager.inspect(T1, 1000))).toEqual({ status: "no_kernel" });
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

  it("a run never waits on a stuck snapshot: past the grace the kernel is restarted", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    control.inspectMode = "stuck";
    expect(await manager.inspect(T1, 50)).toEqual({ ok: true, data: { status: "unavailable" } });
    expect(await manager.inspect(T1, 50)).toEqual({ ok: true, data: { status: "busy" } });
    const started = Date.now();
    const next = data(await exec(manager, frame("print:b")));
    expect(next.status).toBe("restarted");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(control.killed).toEqual([T1]);
    expect(control.executed).toEqual([`${T1}:print:a`]);
    control.inspectMode = "ok";
    expect(data(await exec(manager, frame("print:c")))).toMatchObject({ status: "ok" });
    await manager.stopAll();
  });

  it("Stop releases a run waiting for a stuck snapshot at once", async () => {
    const { launch, control } = fakeLauncher();
    const manager = new KernelManager({
      launch,
      maxKernels: 2,
      idleMs: 60_000,
      graceMs: 60_000,
      readyTimeoutMs: 200,
      log: () => undefined,
    });
    await exec(manager, frame("print:a"));
    control.inspectMode = "stuck";
    await manager.inspect(T1, 50);
    const waiting = exec(manager, frame("print:b"));
    await new Promise((r) => setTimeout(r, 20));
    manager.interrupt(T1);
    expect(data(await waiting).status).toBe("interrupted");
    expect(control.executed).toEqual([`${T1}:print:a`]);
    await manager.stopAll();
  });
});

describe("automatic snapshots pause after one times out (KOBE-803 re-review)", () => {
  it("skips them for the thread across a kernel restart; only an explicit refresh takes one", async () => {
    const { manager, control } = setup();
    control.inspectMode = "stuck";
    const first = data(await exec(manager, frame("print:a", { with_variables: true })));
    expect(first).toMatchObject({ status: "ok", execution_count: 1 });
    expect(data(await manager.inspect(T1, 1000))).toEqual({
      status: "busy",
      auto_paused: "snapshot_timeout",
    });
    // The next run needs the kernel: the stuck snapshot gets it restarted, once.
    expect(data(await exec(manager, frame("print:b", { with_variables: true }))).status).toBe(
      "restarted",
    );
    control.inspectMode = "ok";
    const inspectedBefore = control.inspected.length;
    expect(data(await exec(manager, frame("print:c", { with_variables: true }))).status).toBe("ok");
    expect(data(await exec(manager, frame("print:d", { with_variables: true }))).status).toBe("ok");
    expect(control.inspected).toHaveLength(inspectedBefore);
    expect(control.killed).toEqual([T1]);
    // The route without refresh takes nothing; with refresh it does, and says it is paused.
    expect(data(await manager.inspect(T1, 1000))).toEqual({
      status: "unavailable",
      auto_paused: "snapshot_timeout",
    });
    expect(control.inspected).toHaveLength(inspectedBefore);
    expect(data(await manager.inspect(T1, 1000, true))).toMatchObject({
      status: "ok",
      stale: false,
      auto_paused: "snapshot_timeout",
    });
    // A later run makes that one stale, still without taking another.
    await exec(manager, frame("print:e", { with_variables: true }));
    expect(data(await manager.inspect(T1, 1000))).toMatchObject({
      status: "ok",
      stale: true,
      auto_paused: "snapshot_timeout",
    });
    expect(control.inspected).toHaveLength(inspectedBefore + 1);
    await manager.stopAll();
  });

  it("an explicit refresh that times out answers unavailable, pauses nothing, kills nothing", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a"));
    control.inspectMode = "stuck";
    expect(data(await manager.inspect(T1, 50, true))).toEqual({ status: "unavailable" });
    expect(control.killed).toEqual([]);
    expect(data(await manager.inspect(T1, 50))).toEqual({ status: "busy" });
    await manager.stopAll();
  });
});

describe("Show: one variable, not withheld (KOBE-816)", () => {
  it("asks the bridge for that variable, never answers from or replaces the kept snapshot", async () => {
    const { manager, control } = setup();
    await exec(manager, frame("print:a", { with_variables: true }));
    expect(control.inspected).toHaveLength(1);
    const shown = data(await manager.show(T1, "API_KEY", 1000));
    expect(shown).toMatchObject({ status: "ok", stale: false });
    expect(control.inspected[1]).toBe(`${T1}:${JSON.stringify(INSPECT_LIMITS)}:show=API_KEY`);
    // The kept snapshot is still the one taken after the run (nothing ran since).
    expect(data(await manager.inspect(T1, 1000))).toMatchObject({ stale: false });
    expect(control.inspected).toHaveLength(2);
    await manager.stopAll();
  });

  it("never during a run, never starts a kernel", async () => {
    const { manager, control } = setup();
    expect(data(await manager.show(T1, "x", 1000))).toEqual({ status: "no_kernel" });
    expect(control.launched).toEqual([]);
    await exec(manager, frame("print:a"));
    const running = exec(manager, frame("sleep"));
    await until(() => control.executed.length === 2);
    expect(data(await manager.show(T1, "x", 1000))).toEqual({ status: "busy" });
    manager.interrupt(T1);
    await running;
    await manager.stopAll();
  });
});
