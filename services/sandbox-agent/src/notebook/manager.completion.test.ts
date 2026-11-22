import { randomUUID } from "node:crypto";
import { notebookCompletionResultSchema } from "@kobe/protocol";
import type { NotebookCompletionFrame, NotebookExecuteFrame } from "@kobe/protocol/sandbox-wire";
import { describe, expect, it } from "vitest";
import { KernelManager } from "./manager.js";
import { fakeLauncher } from "./testing/fake-bridge.js";
import { until } from "../testing/until.js";

/** KOBE-808: the editor's kernel completion on the manager. */
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

const execute = (code: string): NotebookExecuteFrame => ({
  v: 1,
  type: "notebook.execute",
  command_id: randomUUID(),
  thread_id: T1,
  run_id: RUN,
  exec_id: randomUUID(),
  code,
  timeout_ms: 10_000,
});

const complete = (code = "df.", extra: Partial<NotebookCompletionFrame> = {}) =>
  ({
    v: 1,
    type: "notebook.inspect",
    command_id: randomUUID(),
    thread_id: T1,
    op: "complete",
    code,
    cursor: code.length,
    timeout_ms: 200,
    ...extra,
  }) as NotebookCompletionFrame;

const doc = (name: string): NotebookCompletionFrame => ({
  v: 1,
  type: "notebook.inspect",
  command_id: randomUUID(),
  thread_id: T1,
  op: "doc",
  name,
  timeout_ms: 200,
});

const data = (o: { ok: boolean; data?: unknown }) => {
  if (!o.ok) throw new Error("command failed");
  return o.data as Record<string, unknown>;
};

describe("kernel completion on the manager (KOBE-808)", () => {
  it("never starts a kernel: no_kernel", async () => {
    const { manager, control } = setup();
    expect(data(await manager.complete(complete()))).toEqual({ status: "no_kernel" });
    expect(data(await manager.complete(doc("x")))).toEqual({ status: "no_kernel" });
    expect(control.launched).toEqual([]);
    expect(control.completed).toEqual([]);
  });

  it("answers matches and docs from an idle kernel, valid on the wire, running no code", async () => {
    const { manager, control } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    const got = data(await manager.complete(complete("df.")));
    expect(got).toEqual({
      status: "ok",
      op: "complete",
      matches: [{ text: "alpha", type: "attribute" }, { text: "beta" }],
      cursor_start: 3,
      cursor_end: 3,
    });
    expect(notebookCompletionResultSchema.safeParse(got).success).toBe(true);
    expect(data(await manager.complete(doc("pd.read_csv")))).toMatchObject({
      status: "ok",
      op: "doc",
      signature: "pd.read_csv(x)",
    });
    expect(control.executed).toEqual([`${T1}:print:a`]);
    await manager.stopAll();
  });

  it("never waits for running code: busy while a cell runs, then answers again", async () => {
    const { manager, control } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    const running = manager.execute(execute("sleep"), () => undefined);
    await until(() => control.executed.length === 2);
    expect(data(await manager.complete(complete()))).toEqual({ status: "busy" });
    expect(control.completed).toEqual([]);
    manager.interrupt(T1);
    await running;
    expect(data(await manager.complete(complete()))).toMatchObject({ status: "ok" });
    await manager.stopAll();
  });

  it("one request at a time: a second one while the first is in the kernel is busy", async () => {
    const { manager, control } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    control.completeMode = "silent";
    const first = manager.complete(complete());
    expect(data(await manager.complete(complete()))).toEqual({ status: "busy" });
    // Past its timeout the first is unavailable, and the kernel takes requests again.
    expect(data(await first)).toEqual({ status: "unavailable" });
    control.completeMode = "ok";
    expect(data(await manager.complete(complete()))).toMatchObject({ status: "ok" });
    await manager.stopAll();
  });

  it("a failed or malformed answer is unavailable, logged without the code", async () => {
    const { manager, control, logs } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    control.completeMode = "fail";
    expect(data(await manager.complete(complete("secret_token.")))).toEqual({
      status: "unavailable",
    });
    control.completeMode = "malformed";
    expect(data(await manager.complete(complete("secret_token.")))).toEqual({
      status: "unavailable",
    });
    expect(logs.some((l) => l.includes("complete"))).toBe(true);
    expect(logs.some((l) => l.includes("secret_token"))).toBe(false);
    await manager.stopAll();
  });

  it("an execution sent while a request is in the kernel still runs", async () => {
    const { manager, control } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    control.completeMode = "silent";
    const pending = manager.complete(complete());
    const ran = data(await manager.execute(execute("print:b"), () => undefined));
    expect(ran.status).toBe("ok");
    expect(data(await pending)).toEqual({ status: "unavailable" });
    await manager.stopAll();
  });

  it("a kernel that goes during a request answers unavailable", async () => {
    const { manager, control } = setup();
    await manager.execute(execute("print:a"), () => undefined);
    control.completeMode = "silent";
    const pending = manager.complete(complete());
    await manager.restart(T1);
    expect(data(await pending)).toEqual({ status: "unavailable" });
    expect(data(await manager.complete(complete()))).toEqual({ status: "no_kernel" });
  });
});
