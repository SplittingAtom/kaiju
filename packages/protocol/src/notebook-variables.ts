import { z } from "zod";
import { timestampSchema, utf8ByteLength } from "./common.js";

/**
 * Python run details (KOBE-803): when an execution ran and how long it took, what its error was,
 * and a snapshot of the kernel's user variables (the editor's Log and Variables tabs). Behind
 * hello capability {@link CAPABILITY_NOTEBOOK_INSPECT}: the server asks for timing on
 * `notebook.execute` (`with_timing`), asks the agent to keep a snapshot after a member's run
 * (`with_variables`), and sends `notebook.inspect` only to agents that announced it, so older
 * agents never see a field they don't know and simply report neither.
 *
 * Variables are never stored: no run event, no audit of values. A repr can hold a secret the
 * member typed into a variable and never printed, so a snapshot only ever goes to the thread's
 * owner, through `POST /v1/threads/{id}/notebook/variables`, and never into the model's context.
 */

/** `hello.capabilities`: the agent measures executions and snapshots the kernel's variables. */
export const CAPABILITY_NOTEBOOK_INSPECT = "notebook_inspect";

/** Most variables (and, separately, most modules/functions/classes) one snapshot lists. */
export const NOTEBOOK_VARIABLES_MAX = 200;
/** Most bytes (JSON) of one snapshot's `variables` and `other` together. */
export const NOTEBOOK_VARIABLES_MAX_BYTES = 64 * 1024;
/** Longest `repr` (characters, an ellipsis included). */
export const NOTEBOOK_REPR_MAX_CHARS = 200;
/** Most DataFrame columns a variable lists (`columns_total` gives the real count). */
export const NOTEBOOK_COLUMNS_MAX = 50;
/** How long one variable's description may take in the kernel before it is given up. */
export const NOTEBOOK_REPR_TIMEOUT_MS = 200;
/** The kernel-side budget of a whole snapshot; variables past it are left out (`truncated`). */
export const NOTEBOOK_INSPECT_BUDGET_MS = 2_000;
/** Default and largest wait for a snapshot's answer; past it the answer is `unavailable`. */
export const NOTEBOOK_INSPECT_TIMEOUT_MS = 5_000;
export const NOTEBOOK_INSPECT_TIMEOUT_MAX_MS = 15_000;

const short = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\u0000"), "U+0000");

/** When an execution ran (sandbox wall clock) and how long (monotonic clock, milliseconds). */
export const notebookTimingSchema = z.strictObject({
  started_at: timestampSchema,
  finished_at: timestampSchema,
  duration_ms: z.number().int().nonnegative(),
});
export type NotebookTiming = z.infer<typeof notebookTimingSchema>;

/**
 * One user variable. `repr` is a short, capped repr (empty when it failed: `repr_error` says
 * why). Summaries only for common types, never the data: `len` for built-in containers, strings
 * and bytes; `shape` and `dtype` for numpy arrays; `shape` (`[rows, columns]`), `columns` (first
 * {@link NOTEBOOK_COLUMNS_MAX} names and dtypes) and `columns_total` for a pandas DataFrame;
 * `shape`, `dtype` and `len` for a pandas Series.
 */
export const notebookVariableSchema = z.strictObject({
  name: short(256).min(1),
  /** The type's qualified name (`int`, `DataFrame`, `ndarray`, `MyClass`). */
  type: short(256).min(1),
  /** The type's top-level package (`numpy`, `pandas`, `__main__`); absent for built-ins. */
  module: short(128).optional(),
  repr: short(NOTEBOOK_REPR_MAX_CHARS),
  /** The repr (or summary) raised, or took longer than {@link NOTEBOOK_REPR_TIMEOUT_MS}. */
  repr_error: z.enum(["raised", "timeout"]).optional(),
  len: z.number().int().nonnegative().optional(),
  shape: z.array(z.number().int().nonnegative()).max(64).optional(),
  dtype: short(128).optional(),
  columns: z
    .array(z.strictObject({ name: short(128), dtype: short(128) }))
    .max(NOTEBOOK_COLUMNS_MAX)
    .optional(),
  columns_total: z.number().int().nonnegative().optional(),
});
export type NotebookVariable = z.infer<typeof notebookVariableSchema>;

/** A module, function or class in the namespace: listed by name only, never described. */
export const notebookOtherNameSchema = z.strictObject({
  name: short(256).min(1),
  kind: z.enum(["module", "function", "class"]),
});
export type NotebookOtherName = z.infer<typeof notebookOtherNameSchema>;

/**
 * Why the agent stopped taking a snapshot after each run for this thread (only an explicit
 * `refresh` takes one then): `snapshot_timeout`, one taken after a run did not finish in time (an
 * object whose repr hangs in C code would otherwise get the kernel restarted after every run).
 * Lasts until the sandbox restarts.
 */
export const notebookAutoPausedSchema = z.enum(["snapshot_timeout"]);

/**
 * A snapshot of the kernel's user namespace, taken silently (no execution count, no `Out`/`_`,
 * not a run). Left out: names starting with `_` and IPython's own (`In`, `Out`, `exit`, `quit`,
 * `get_ipython`). Sorted by name. `truncated`: a cap (count, bytes or the kernel-side budget)
 * left variables out. `execution_count`: the kernel's count when it was taken. `stale`: the agent
 * answered from the snapshot it keeps (taken after the last member run, or by the last refresh)
 * while code has run since or is running now (`taken_at` says when it was taken).
 */
export const notebookVariablesSnapshotSchema = z
  .strictObject({
    status: z.literal("ok"),
    taken_at: timestampSchema,
    execution_count: z.number().int().nonnegative().nullable(),
    variables: z.array(notebookVariableSchema).max(NOTEBOOK_VARIABLES_MAX),
    other: z.array(notebookOtherNameSchema).max(NOTEBOOK_VARIABLES_MAX),
    truncated: z.boolean(),
    stale: z.boolean().optional(),
    auto_paused: notebookAutoPausedSchema.optional(),
  })
  .refine(
    (s) =>
      utf8ByteLength(JSON.stringify(s.variables)) + utf8ByteLength(JSON.stringify(s.other)) <=
      NOTEBOOK_VARIABLES_MAX_BYTES + 1024,
    "snapshot too large",
  );
export type NotebookVariablesSnapshot = z.infer<typeof notebookVariablesSnapshotSchema>;

/**
 * No snapshot: `busy` (an execution runs or waits), `no_kernel` (the thread has no live kernel;
 * none is started for a snapshot), `unavailable` (the kernel did not answer in time, or the
 * introspection failed).
 */
export const notebookVariablesMissingSchema = z.strictObject({
  status: z.enum(["busy", "no_kernel", "unavailable"]),
  auto_paused: notebookAutoPausedSchema.optional(),
});

/**
 * `command.result.data` of `notebook.inspect`, and the answer of
 * `POST /v1/threads/{id}/notebook/variables`.
 */
export const notebookVariablesResultSchema = z.union([
  notebookVariablesSnapshotSchema,
  notebookVariablesMissingSchema,
]);
export type NotebookVariablesResult = z.infer<typeof notebookVariablesResultSchema>;

/**
 * `POST /v1/threads/{id}/notebook/variables` body (optional): `refresh: true` asks for a fresh
 * snapshot when the kernel is idle; without it the agent may answer with the one it keeps when
 * nothing ran since. While code runs the kept snapshot comes back `stale` (or `busy` without one).
 */
export const notebookVariablesBodySchema = z.strictObject({
  refresh: z.boolean().optional(),
});
export type NotebookVariablesBody = z.infer<typeof notebookVariablesBodySchema>;

/**
 * The run log's error (on `notebook.finished`): the exception's class name and, when the
 * traceback names it, the line in the code that ran (the cell, or the `.py` file) where it was
 * raised, from the innermost frame of that code.
 */
export const notebookExecErrorSchema = z.strictObject({
  name: short(256),
  line: z.number().int().positive().optional(),
});
export type NotebookExecError = z.infer<typeof notebookExecErrorSchema>;
