import type { KaijuEvent, KaijuEventPayload, KaijuEventType } from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import {
  NotebookExecStore,
  agentCodeRuns,
  egressNotices,
  fileRuns,
  kernelBusy,
  lastFinished,
  latestRun,
} from "./executions";

const RUN = "00000000-0000-4000-8000-000000000101";
const RUN2 = "00000000-0000-4000-8000-000000000102";
const E1 = "00000000-0000-4000-8000-000000000301";
const E2 = "00000000-0000-4000-8000-000000000302";
const TH = "th1";

let seq = 0;
function ev<T extends KaijuEventType>(type: T, payload: KaijuEventPayload<T>, run = RUN): KaijuEvent {
  seq += 1;
  return { run_id: run, seq, ts: "2026-10-21T10:00:00Z", type, payload } as KaijuEvent;
}
const out = (exec: string, index: number, text: string) =>
  ev("notebook.output", {
    exec_id: exec,
    index,
    output: { output_type: "stream", name: "stdout", text },
  });

describe("NotebookExecStore", () => {
  it("assembles an execution from its events, idempotently and in index order", () => {
    const store = new NotebookExecStore();
    let changes = 0;
    store.subscribe(() => changes++);
    const events = [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "a.ipynb", cell_id: "c1" }),
      out(E1, 1, "second"),
      out(E1, 0, "first"),
    ];
    store.apply(TH, events);
    store.apply(TH, events); // a replay changes nothing
    expect(changes).toBe(1);
    const [exec] = store.snapshot();
    expect(exec).toMatchObject({ threadId: TH, runId: RUN, execId: E1, cellId: "c1" });
    expect(exec?.outputs.map((o) => o?.output_type === "stream" && o.text)).toEqual([
      "first",
      "second",
    ]);
    expect(kernelBusy(store.snapshot(), TH)).toBe(true);
    expect(latestRun(store.snapshot(), TH, "a.ipynb", "c1")?.execId).toBe(E1);
    expect(latestRun(store.snapshot(), TH, "a.ipynb", "c2")).toBeUndefined();
    expect(latestRun(store.snapshot(), "other", "a.ipynb", "c1")).toBeUndefined();

    const saved = { path: "a.ipynb", sha256: "f".repeat(64) };
    store.apply(TH, [
      ev("notebook.finished", {
        exec_id: E1,
        status: "ok",
        execution_count: 4,
        outputs: 2,
        truncated: false,
        saved,
      }),
    ]);
    expect(store.snapshot()[0]?.finished).toMatchObject({ status: "ok", saved });
    expect(kernelBusy(store.snapshot(), TH)).toBe(false);
  });

  it("ends executions a run ended without finishing", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" }),
      ev("run.interrupted", { reason: "cancelled", last_entry_id: null, retryable: false }),
    ]);
    expect(store.snapshot()[0]?.finished).toMatchObject({ status: "interrupted", saved: null });
    store.apply(TH, [
      ev("notebook.started", { exec_id: E2, origin: "agent", tool_call_id: "t1" }, RUN2),
      ev("run.failed", { error: { code: "x", message: "y" } }, RUN2),
    ]);
    expect(store.snapshot()[1]?.finished?.status).toBe("failed");
    expect(latestRun(store.snapshot(), TH, "x.py")?.execId).toBe(E1);
    expect(agentCodeRuns(store.snapshot(), TH).map((e) => e.execId)).toEqual([E2]);
  });

  it("ends a run's executions when its stream closed without their end", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" })]);
    let changes = 0;
    store.subscribe(() => changes++);
    store.endRun("other-run");
    expect(changes).toBe(0);
    store.endRun(RUN);
    store.endRun(RUN);
    expect(changes).toBe(1);
    expect(store.snapshot()[0]?.finished?.status).toBe("failed");
  });

  it("keeps blocked domains of the member's own notebook runs", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" }),
      ev("egress.blocked", { domain: "example.com", request_access: true }),
      ev("egress.blocked", { domain: "example.com", request_access: true }),
    ]);
    store.apply(TH, [
      ev("notebook.started", { exec_id: E2, origin: "agent" }, RUN2),
      ev("egress.blocked", { domain: "agent.example", request_access: true }, RUN2),
    ]);
    expect(egressNotices(store.snapshot(), store.egress(), TH, "x.py")).toEqual([
      {
        runId: RUN,
        payload: { domain: "example.com", request_access: true },
        blockedAt: "2026-10-21T10:00:00Z",
      },
    ]);
  });

  it("forgets the oldest executions past its cap", () => {
    const store = new NotebookExecStore(2);
    for (const id of [E1, E2, "00000000-0000-4000-8000-000000000303"]) {
      store.apply(TH, [ev("notebook.started", { exec_id: id, origin: "agent" })]);
    }
    expect(store.snapshot().map((e) => e.execId)).toEqual([
      E2,
      "00000000-0000-4000-8000-000000000303",
    ]);
  });

  it("keeps when a run started, its timing and error, and a selection's lines (KOBE-804/805)", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", {
        exec_id: E1,
        origin: "user",
        path: "a.py",
        lines: { start: 3, end: 5 },
      }),
    ]);
    store.apply(TH, [
      ev("notebook.finished", {
        exec_id: E1,
        status: "error",
        execution_count: 2,
        outputs: 0,
        truncated: false,
        saved: null,
        timing: {
          started_at: "2026-10-21T10:00:00Z",
          finished_at: "2026-10-21T10:00:01.5Z",
          duration_ms: 1500,
        },
        error: { name: "KeyError", line: 2 },
      }),
    ]);
    const [exec] = store.snapshot();
    expect(exec).toMatchObject({
      startedAt: "2026-10-21T10:00:00Z",
      lines: { start: 3, end: 5 },
      finished: { timing: { durationMs: 1500 }, error: { name: "KeyError", line: 2 } },
    });
    expect(lastFinished(store.snapshot(), TH)?.execId).toBe(E1);
    expect(lastFinished(store.snapshot(), "other")).toBeUndefined();
  });

  it("seeds a file's past runs from the server before the ones it saw, outputs on demand (KOBE-804)", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [ev("notebook.started", { exec_id: E2, origin: "user", path: "a.py" })]);
    const old = "00000000-0000-4000-8000-000000000303";
    const entry = (exec: string, outputs: number | null, ended = true) => ({
      run_id: RUN,
      run_ended: ended,
      started_at: "2026-11-22T09:00:00Z",
      started: {
        exec_id: exec,
        origin: "user" as const,
        path: "a.py",
        lines: { start: 4, end: 4 },
      },
      finished:
        outputs === null
          ? null
          : {
              exec_id: exec,
              status: "error" as const,
              execution_count: 1,
              outputs,
              truncated: false,
              saved: null,
              error: { name: "KeyError", line: 1 },
            },
    });
    const live = "00000000-0000-4000-8000-000000000304";
    const orphan = "00000000-0000-4000-8000-000000000305";
    store.seed(TH, [entry(live, null, false), entry(E2, 1), entry(old, 2), entry(E1, 0)]);
    store.seed(TH, [entry(orphan, null, true)]);
    expect(store.snapshot().some((e) => e.execId === live)).toBe(false);
    expect(store.snapshot().find((e) => e.execId === orphan)).toMatchObject({
      finished: { status: "failed" },
      outputsPending: true,
    });
    expect(kernelBusy(store.snapshot(), TH)).toBe(true); // E2, seen live, still runs
    expect(fileRuns(store.snapshot(), TH, "a.py").map((e) => e.execId)).toEqual([
      E2,
      old,
      E1,
      orphan,
    ]);
    const seeded = store.snapshot().find((e) => e.execId === old);
    expect(seeded).toMatchObject({
      outputsPending: true,
      lines: { start: 4, end: 4 },
      seenAt: Date.parse("2026-11-22T09:00:00Z"),
      finished: { error: { line: 1 } },
    });
    expect(store.snapshot().find((e) => e.execId === E1)?.outputsPending).toBe(false);
    store.fillOutputs(old, [{ output_type: "stream", name: "stdout", text: "x" }]);
    expect(store.snapshot().find((e) => e.execId === old)).toMatchObject({
      outputsPending: false,
      outputs: [{ text: "x" }],
    });
  });

  it("lists a file's runs newest first (the Log tab)", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "a.py" }),
      ev("notebook.started", { exec_id: E2, origin: "agent", path: "a.py", tool_call_id: "t" }),
      ev("notebook.started", {
        exec_id: "00000000-0000-4000-8000-000000000303",
        origin: "user",
        path: "b.py",
      }),
    ]);
    expect(fileRuns(store.snapshot(), TH, "a.py").map((e) => e.execId)).toEqual([E2, E1]);
    expect(fileRuns(store.snapshot(), "other", "a.py")).toEqual([]);
  });
});
