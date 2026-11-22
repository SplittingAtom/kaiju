import { PassThrough } from "node:stream";
import type { BridgeLauncher, BridgeProcess } from "../session.js";

/**
 * An in-memory `kobe-kernel-bridge.py` for tests. Code is a tiny script language:
 *   `print:<text>`  a stdout stream output, then done ok
 *   `result:<text>` an execute_result with text/plain, then done ok
 *   `sleep`         runs until interrupted (KeyboardInterrupt, done interrupted)
 *   `hang`          ignores interrupts (only a stop ends it)
 *   `die`           the kernel dies (`died`, then the bridge exits)
 *   `flood:<n>`     n stdout outputs of 1 KiB each, then done ok
 *   `fail`          an error output, done error
 * `inspect` (KOBE-803) answers per `control.inspectMode`: `ok` (a one-variable snapshot with the
 * current execution count, which it never bumps), `fail` (an error), `malformed` (an invalid
 * snapshot), `hang` (answers an error once interrupted), `stuck` (ignores interrupts too).
 */
export type FakeInspectMode = "ok" | "fail" | "malformed" | "hang" | "stuck";

export interface FakeBridgeOptions {
  /** Never sends `ready` (a kernel that does not start). */
  readonly neverReady?: boolean;
  /** Sends `fatal` instead of `ready`. */
  readonly fatal?: string;
}

export interface FakeBridgeControl {
  readonly launched: string[];
  readonly killed: string[];
  readonly interrupts: string[];
  /** Every cell the bridges were asked to run, in order (`<thread id>:<code>`). */
  readonly executed: string[];
  /** Every snapshot asked for (`<thread id>:<limits as JSON>`). */
  readonly inspected: string[];
  inspectMode: FakeInspectMode;
}

export function fakeLauncher(options: FakeBridgeOptions = {}): {
  launch: BridgeLauncher;
  control: FakeBridgeControl;
} {
  const control: FakeBridgeControl = {
    launched: [],
    killed: [],
    interrupts: [],
    executed: [],
    inspected: [],
    inspectMode: "ok",
  };
  const launch: BridgeLauncher = (threadId) => {
    control.launched.push(threadId);
    return Promise.resolve(fakeBridge(threadId, control, options));
  };
  return { launch, control };
}

function fakeBridge(
  threadId: string,
  control: FakeBridgeControl,
  options: FakeBridgeOptions,
): BridgeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: (v: { code: number | null; signal: string | null }) => void = () => undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (exit = r));
  let count = 0;
  let current: { id: string; code: string } | undefined;
  let inspecting: { id: string; mode: FakeInspectMode } | undefined;
  let gone = false;
  const send = (m: unknown) => {
    if (!gone) stdout.write(`${JSON.stringify(m)}\n`);
  };
  const end = (code: number | null, signal: string | null) => {
    if (gone) return;
    gone = true;
    stdout.end();
    exit({ code, signal });
  };
  const done = (id: string, status: string) => {
    current = undefined;
    send({ ev: "done", id, status, execution_count: status === "ok" ? ++count : count });
  };
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const m = JSON.parse(line) as { op: string; id?: string; code?: string; limits?: unknown };
      if (m.op === "interrupt") {
        control.interrupts.push(threadId);
        if (inspecting?.mode === "hang") {
          send({ ev: "inspected", id: inspecting.id, error: "KeyboardInterrupt" });
          inspecting = undefined;
        }
        if (current?.code === "sleep") {
          send({
            ev: "output",
            id: current.id,
            output: { output_type: "error", ename: "KeyboardInterrupt", evalue: "", traceback: [] },
          });
          done(current.id, "interrupted");
        }
      } else if (m.op === "shutdown") {
        end(0, null);
      } else if (m.op === "execute" && m.id !== undefined && m.code !== undefined) {
        run(m.id, m.code);
      } else if (m.op === "inspect" && m.id !== undefined) {
        inspect(m.id, m.limits);
      }
    }
  });
  const inspect = (id: string, limits: unknown) => {
    control.inspected.push(`${threadId}:${JSON.stringify(limits)}`);
    const mode = control.inspectMode;
    if (mode === "ok") {
      send({
        ev: "inspected",
        id,
        snapshot: {
          variables: [{ name: "x", type: "int", repr: "1" }],
          other: [{ name: "np", kind: "module" }],
          truncated: false,
          execution_count: count,
        },
      });
    } else if (mode === "fail") {
      send({ ev: "inspected", id, error: "NameError" });
    } else if (mode === "malformed") {
      send({ ev: "inspected", id, snapshot: { variables: "nope" } });
    } else {
      inspecting = { id, mode };
    }
  };
  const run = (id: string, code: string) => {
    current = { id, code };
    control.executed.push(`${threadId}:${code}`);
    if (code.startsWith("print:")) {
      send({
        ev: "output",
        id,
        output: { output_type: "stream", name: "stdout", text: code.slice(6) },
      });
      done(id, "ok");
    } else if (code.startsWith("result:")) {
      send({
        ev: "output",
        id,
        output: {
          output_type: "execute_result",
          execution_count: count + 1,
          data: { "text/plain": code.slice(7) },
          metadata: {},
        },
      });
      done(id, "ok");
    } else if (code.startsWith("flood:")) {
      for (let i = 0; i < Number(code.slice(6)); i++) {
        send({
          ev: "output",
          id,
          output: {
            output_type: "display_data",
            data: { "text/plain": "x".repeat(1024) },
            metadata: {},
          },
        });
      }
      done(id, "ok");
    } else if (code === "fail") {
      send({
        ev: "output",
        id,
        output: { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["tb"] },
      });
      done(id, "error");
    } else if (code === "die") {
      send({ ev: "died" });
      end(1, null);
    }
    // sleep / hang: wait
  };
  queueMicrotask(() => {
    if (options.fatal !== undefined) send({ ev: "fatal", message: options.fatal });
    else if (options.neverReady !== true) send({ ev: "ready" });
  });
  return {
    stdin,
    stdout,
    stderr,
    exited,
    kill() {
      control.killed.push(threadId);
      end(null, "SIGKILL");
      return Promise.resolve();
    },
  };
}
