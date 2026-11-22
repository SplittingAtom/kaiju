import { describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_INSPECT,
  NOTEBOOK_COLUMNS_MAX,
  NOTEBOOK_REPR_MAX_CHARS,
  NOTEBOOK_VARIABLES_MAX,
  notebookExecErrorSchema,
  notebookTimingSchema,
  notebookVariablesBodySchema,
  notebookVariableSchema,
  notebookVariablesResultSchema,
  notebookVariablesSnapshotSchema,
} from "./notebook-variables.js";
import {
  NOTEBOOK_ERROR_CODES,
  notebookExecuteResultSchema,
  notebookFinishedPayloadSchema,
  notebookInspectResultSchema,
} from "./notebooks.js";
import { notebookExecuteFrameSchema, notebookInspectFrameSchema } from "./sandbox-wire/index.js";
import { serverToSandboxFrameSchema } from "./sandbox-wire/frames.js";

const THREAD = "5a2b3c4d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const RUN = "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const EXEC = "6b3c4d5e-7f8a-4b9c-8d1e-2f3a4b5c6d7e";

const timing = {
  started_at: "2026-11-22T10:00:00.000Z",
  finished_at: "2026-11-22T10:00:01.250Z",
  duration_ms: 1250,
};

const snapshot = {
  status: "ok",
  taken_at: "2026-11-22T10:00:01.300Z",
  execution_count: 3,
  variables: [
    { name: "n", type: "int", repr: "42" },
    { name: "xs", type: "list", repr: "[1, 2, 3]", len: 3 },
    {
      name: "a",
      type: "ndarray",
      module: "numpy",
      repr: "array([0., 0.])",
      shape: [2],
      dtype: "float64",
    },
    {
      name: "df",
      type: "DataFrame",
      module: "pandas",
      repr: "DataFrame: 3 rows × 2 columns",
      shape: [3, 2],
      columns: [
        { name: "a", dtype: "int64" },
        { name: "b", dtype: "object" },
      ],
      columns_total: 2,
    },
    { name: "bad", type: "Weird", module: "__main__", repr: "", repr_error: "raised" },
  ],
  other: [
    { name: "np", kind: "module" },
    { name: "f", kind: "function" },
    { name: "C", kind: "class" },
  ],
  truncated: false,
};

describe("variables snapshot contract (KOBE-803)", () => {
  it("names its capability", () => {
    expect(CAPABILITY_NOTEBOOK_INSPECT).toBe("notebook_inspect");
  });

  it("accepts a snapshot with summaries, and the missing answers", () => {
    expect(notebookVariablesSnapshotSchema.safeParse(snapshot).success).toBe(true);
    for (const status of ["busy", "no_kernel", "unavailable"]) {
      expect(notebookVariablesResultSchema.safeParse({ status }).success).toBe(true);
      expect(notebookInspectResultSchema.safeParse({ status }).success).toBe(true);
    }
    expect(notebookVariablesResultSchema.safeParse({ status: "waking" }).success).toBe(false);
    expect(notebookVariablesResultSchema.safeParse({ ...snapshot, extra: 1 }).success).toBe(false);
  });

  it("caps the repr, the counts, the columns and the bytes", () => {
    const v = { name: "s", type: "str", repr: "x".repeat(NOTEBOOK_REPR_MAX_CHARS) };
    expect(notebookVariableSchema.safeParse(v).success).toBe(true);
    expect(notebookVariableSchema.safeParse({ ...v, repr: `${v.repr}x` }).success).toBe(false);
    expect(notebookVariableSchema.safeParse({ ...v, repr: "a\u0000" }).success).toBe(false);
    expect(notebookVariableSchema.safeParse({ ...v, repr_error: "hung" }).success).toBe(false);
    const col = { name: "c", dtype: "int64" };
    expect(
      notebookVariableSchema.safeParse({
        ...v,
        columns: Array.from({ length: NOTEBOOK_COLUMNS_MAX + 1 }, () => col),
      }).success,
    ).toBe(false);
    const many = Array.from({ length: NOTEBOOK_VARIABLES_MAX + 1 }, (_, i) => ({
      name: `v${i}`,
      type: "int",
      repr: "1",
    }));
    expect(
      notebookVariablesSnapshotSchema.safeParse({ ...snapshot, variables: many }).success,
    ).toBe(false);
    const big = Array.from({ length: 200 }, (_, i) => ({
      name: `v${i}`,
      type: "str",
      repr: "y".repeat(NOTEBOOK_REPR_MAX_CHARS),
      columns: Array.from({ length: 10 }, () => ({ name: "n".repeat(100), dtype: "object" })),
    }));
    expect(notebookVariablesSnapshotSchema.safeParse({ ...snapshot, variables: big }).success).toBe(
      false,
    );
  });

  it("timing is UTC instants and a whole number of milliseconds", () => {
    expect(notebookTimingSchema.safeParse(timing).success).toBe(true);
    expect(notebookTimingSchema.safeParse({ ...timing, duration_ms: 1.5 }).success).toBe(false);
    expect(notebookTimingSchema.safeParse({ ...timing, started_at: "yesterday" }).success).toBe(
      false,
    );
  });

  it("an error is a name and maybe a positive line", () => {
    expect(notebookExecErrorSchema.safeParse({ name: "ZeroDivisionError", line: 3 }).success).toBe(
      true,
    );
    expect(notebookExecErrorSchema.safeParse({ name: "E" }).success).toBe(true);
    expect(notebookExecErrorSchema.safeParse({ name: "E", line: 0 }).success).toBe(false);
  });
});

describe("wire and events stay additive (KOBE-803)", () => {
  const execute = {
    v: 1,
    type: "notebook.execute",
    command_id: "c1",
    thread_id: THREAD,
    run_id: RUN,
    exec_id: EXEC,
    code: "1+1",
    timeout_ms: 60_000,
  };

  it("notebook.execute asks for timing and variables only with literal true", () => {
    expect(notebookExecuteFrameSchema.safeParse(execute).success).toBe(true);
    const asked = { ...execute, with_timing: true, with_variables: true };
    expect(notebookExecuteFrameSchema.safeParse(asked).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse(asked).success).toBe(true);
    expect(notebookExecuteFrameSchema.safeParse({ ...execute, with_timing: false }).success).toBe(
      false,
    );
  });

  it("notebook.inspect is a command with a bounded timeout", () => {
    const f = { v: 1, type: "notebook.inspect", command_id: "c9", thread_id: THREAD };
    expect(notebookInspectFrameSchema.safeParse(f).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse({ ...f, timeout_ms: 5000 }).success).toBe(true);
    expect(notebookInspectFrameSchema.safeParse({ ...f, timeout_ms: 100 }).success).toBe(false);
    expect(notebookInspectFrameSchema.safeParse({ ...f, timeout_ms: 60_000 }).success).toBe(false);
    expect(notebookInspectFrameSchema.safeParse({ ...f, code: "x" }).success).toBe(false);
    expect(notebookInspectFrameSchema.safeParse({ ...f, refresh: true }).success).toBe(true);
    expect(notebookInspectFrameSchema.safeParse({ ...f, refresh: false }).success).toBe(false);
  });

  it("a kept snapshot may say it is stale; the route body only asks for a refresh", () => {
    expect(notebookVariablesSnapshotSchema.safeParse({ ...snapshot, stale: true }).success).toBe(
      true,
    );
    expect(notebookVariablesBodySchema.safeParse({}).success).toBe(true);
    expect(notebookVariablesBodySchema.safeParse({ refresh: true }).success).toBe(true);
    expect(notebookVariablesBodySchema.safeParse({ refresh: true, x: 1 }).success).toBe(false);
  });

  it("an old result (no timing) still parses; a new one carries timing, never variables", () => {
    const old = { status: "ok", execution_count: 1, outputs: 0, truncated: false };
    expect(notebookExecuteResultSchema.safeParse(old).success).toBe(true);
    expect(notebookExecuteResultSchema.safeParse({ ...old, timing }).success).toBe(true);
    expect(notebookExecuteResultSchema.safeParse({ ...old, variables: snapshot }).success).toBe(
      false,
    );
  });

  it("notebook.finished carries the run log fields optionally, and never variables", () => {
    const finished = {
      exec_id: EXEC,
      status: "error",
      execution_count: 4,
      outputs: 1,
      truncated: false,
      saved: null,
    };
    expect(notebookFinishedPayloadSchema.safeParse(finished).success).toBe(true);
    expect(
      notebookFinishedPayloadSchema.safeParse({
        ...finished,
        timing,
        error: { name: "ValueError", line: 2 },
      }).success,
    ).toBe(true);
    expect(
      notebookFinishedPayloadSchema.safeParse({ ...finished, variables: snapshot }).success,
    ).toBe(false);
  });

  it("the route has a code for an agent without snapshots", () => {
    expect(NOTEBOOK_ERROR_CODES).toContain("variables_unsupported");
  });
});
