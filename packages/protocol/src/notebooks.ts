import { z } from "zod";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";
import {
  notebookExecErrorSchema,
  notebookTimingSchema,
  notebookVariablesResultSchema,
} from "./notebook-variables.js";
import { sha256HexSchema, workspacePathSchema } from "./workspace-paths.js";

/**
 * Notebooks contract (KOBE-464; decisions NB1..NB16 in docs/specs/notebooks.md). A live Python
 * kernel per thread in the member's sandbox; the member runs a cell or a `.py` file (REST, below),
 * the agent runs code with `run_python` under the team's tool policy. Outputs are nbformat 4
 * outputs, bounded, streamed as run events and saved into the `.ipynb` through the file editor's
 * save path. Additive: an agent without {@link CAPABILITY_NOTEBOOKS} never registers the tool and
 * is never sent a kernel command.
 */

/** `hello.capabilities` entry of an agent that runs a kernel and registers `run_python`. */
export const CAPABILITY_NOTEBOOKS = "notebooks";
/**
 * `hello.capabilities` entry of an agent that takes `notebook.restart` with `op: "start"`
 * (KOBE-477): start the thread's kernel without running code. Never sent to agents without it.
 */
export const CAPABILITY_NOTEBOOK_START = "notebook_start";
export const RUN_PYTHON_TOOL = "run_python";

/** Largest code one execution runs (UTF-8 bytes): a cell, a `.py` file or the tool's `code`. */
export const NOTEBOOK_CODE_MAX_BYTES = 256 * 1024;
/** Largest single output as JSON: one run event and one small wire frame (NB9). */
export const NOTEBOOK_OUTPUT_MAX_BYTES = 192 * 1024;
/** Most outputs one execution keeps (the truncation marker included). */
export const NOTEBOOK_EXEC_OUTPUTS_MAX = 200;
/** Most output bytes (JSON) one execution keeps. */
export const NOTEBOOK_EXEC_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
/** Largest `.ipynb` the server reads and writes. */
export const NOTEBOOK_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** What the model gets back from `run_python` (UTF-8 bytes of `text`). */
export const NOTEBOOK_TOOL_TEXT_MAX_BYTES = 16 * 1024;
export const NOTEBOOK_TIMEOUT_DEFAULT_S = 600;
export const NOTEBOOK_TIMEOUT_MAX_S = 3600;
/** The truncation marker's text starts with this (a `stream` output on `stderr`). */
export const NOTEBOOK_TRUNCATED_PREFIX = "[Kaiju: output truncated";

/** nbformat 4.5 cell id. */
export const notebookCellIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "a notebook cell id (letters, digits, - and _)");

/** A runnable workspace file: a notebook or a Python file. */
export const notebookPathSchema = workspacePathSchema.refine(
  (p) => p.endsWith(".ipynb") || p.endsWith(".py"),
  "an .ipynb or .py file",
);

const timeoutSchema = z.number().int().min(1).max(NOTEBOOK_TIMEOUT_MAX_S);

// ----------------------------------------------------------------------------- outputs (NB4)

/** MIME types an output may carry; anything else is dropped by the agent, refused by the server. */
export const NOTEBOOK_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/latex",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "application/json",
] as const;
export type NotebookMimeType = (typeof NOTEBOOK_MIME_TYPES)[number];

const text = z.string().refine((s) => !s.includes("\u0000"), "U+0000");
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

/** A MIME bundle: text types and SVG as strings, PNG/JPEG as base64, JSON as any value. */
export const notebookMimeBundleSchema = z
  .partialRecord(z.enum(NOTEBOOK_MIME_TYPES), z.unknown())
  .superRefine((bundle, ctx) => {
    for (const [mime, value] of Object.entries(bundle)) {
      if (mime === "application/json") continue;
      if (typeof value !== "string" || value.includes("\u0000")) {
        ctx.addIssue({ code: "custom", message: `${mime} must be a string` });
      } else if ((mime === "image/png" || mime === "image/jpeg") && !BASE64.test(value)) {
        ctx.addIssue({ code: "custom", message: `${mime} must be base64` });
      }
    }
  })
  .refine((bundle) => Object.keys(bundle).length > 0, "an empty MIME bundle");

const metadataSchema = z.record(z.string().max(256), z.unknown());

export const notebookStreamOutputSchema = z.strictObject({
  output_type: z.literal("stream"),
  name: z.enum(["stdout", "stderr"]),
  text,
});
export const notebookDisplayOutputSchema = z.strictObject({
  output_type: z.literal("display_data"),
  data: notebookMimeBundleSchema,
  metadata: metadataSchema,
});
export const notebookResultOutputSchema = z.strictObject({
  output_type: z.literal("execute_result"),
  execution_count: z.number().int().nonnegative().nullable(),
  data: notebookMimeBundleSchema,
  metadata: metadataSchema,
});
export const notebookErrorOutputSchema = z.strictObject({
  output_type: z.literal("error"),
  ename: z.string().max(256),
  evalue: text,
  traceback: z.array(text).max(1000),
});

/** One nbformat 4 output as Kaiju stores, streams and saves it (at most NOTEBOOK_OUTPUT_MAX_BYTES). */
export const notebookOutputSchema = z
  .discriminatedUnion("output_type", [
    notebookStreamOutputSchema,
    notebookDisplayOutputSchema,
    notebookResultOutputSchema,
    notebookErrorOutputSchema,
  ])
  .refine(
    (o) => utf8ByteLength(JSON.stringify(o)) <= NOTEBOOK_OUTPUT_MAX_BYTES,
    "output too large",
  );
export type NotebookOutput = z.infer<typeof notebookOutputSchema>;

// ----------------------------------------------------------------------------- executions

/**
 * How an execution ended. `failed`: the sandbox could not run it (no kernel could start, the
 * sandbox went away); the others are the kernel's.
 */
export const NOTEBOOK_EXEC_STATUSES = [
  "ok",
  "error",
  "interrupted",
  "timeout",
  "restarted",
  "failed",
] as const;
export const notebookExecStatusSchema = z.enum(NOTEBOOK_EXEC_STATUSES);
export type NotebookExecStatus = z.infer<typeof notebookExecStatusSchema>;

/** Where an execution's outputs were saved: the notebook and its new version. */
export const notebookSavedSchema = z.strictObject({
  path: workspacePathSchema,
  sha256: sha256HexSchema,
});

/** Highest line a Run selection names (KOBE-805); files are capped far below this anyway. */
export const NOTEBOOK_LINE_MAX = 1_000_000;

/** Lines of a `.py` file (1-based, inclusive): a Run selection (KOBE-805). */
export const notebookLineRangeSchema = z
  .strictObject({
    start: z.number().int().min(1).max(NOTEBOOK_LINE_MAX),
    end: z.number().int().min(1).max(NOTEBOOK_LINE_MAX),
  })
  .refine((l) => l.end >= l.start, "end before start");
export type NotebookLineRange = z.infer<typeof notebookLineRangeSchema>;

/** `notebook.started`: an execution began (the member's `notebook` run, or a `run_python` call). */
export const notebookStartedPayloadSchema = z.strictObject({
  exec_id: uuidSchema,
  origin: z.enum(["user", "agent"]),
  tool_call_id: idSchema.optional(),
  path: workspacePathSchema.optional(),
  cell_id: notebookCellIdSchema.optional(),
  /** KOBE-805: only these lines of the `.py` file ran (a Run selection); error lines count from `start`. */
  lines: notebookLineRangeSchema.optional(),
});
export type NotebookStartedPayload = z.infer<typeof notebookStartedPayloadSchema>;

/** `notebook.output`: the execution's `index`-th output (0-based, in order). */
export const notebookOutputPayloadSchema = z.strictObject({
  exec_id: uuidSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(NOTEBOOK_EXEC_OUTPUTS_MAX - 1),
  output: notebookOutputSchema,
});
export type NotebookOutputPayload = z.infer<typeof notebookOutputPayloadSchema>;

/**
 * `notebook.finished`: how it ended. `outputs` = how many `notebook.output` events it has;
 * `truncated`: a cap cut it (NB9). `saved`: the `.ipynb` version holding its outputs, null when
 * nothing was saved (`.py`, ad-hoc code, or `save_error`).
 */
export const notebookFinishedPayloadSchema = z.strictObject({
  exec_id: uuidSchema,
  status: notebookExecStatusSchema,
  execution_count: z.number().int().nonnegative().nullable(),
  outputs: z.number().int().min(0).max(NOTEBOOK_EXEC_OUTPUTS_MAX),
  truncated: z.boolean(),
  saved: notebookSavedSchema.nullable(),
  /** Why the outputs were not saved (`version_conflict`, `cell_not_found`, `read_only`, ...). */
  save_error: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  /**
   * KOBE-803, the run log: when it ran and how long (absent from agents without
   * `notebook_inspect`, and when it never ran: dropped, timed out waiting, failed).
   */
  timing: notebookTimingSchema.optional(),
  /** KOBE-803: the exception of an `error` execution (name, and its line when known). */
  error: notebookExecErrorSchema.optional(),
});
export type NotebookFinishedPayload = z.infer<typeof notebookFinishedPayloadSchema>;

// ----------------------------------------------------------------------------- REST (member)

/**
 * `POST /v1/threads/{id}/notebook/run` (thread owner only): run one code cell of an `.ipynb`
 * (`cell_id` required) or a whole `.py` file (no `cell_id`), read from the owner's synced copy, in
 * the thread's kernel. 202 {@link notebookRunResponseSchema}; follow `GET /v1/runs/{run_id}/events`.
 */
export const notebookRunBodySchema = z
  .strictObject({
    path: notebookPathSchema,
    cell_id: notebookCellIdSchema.optional(),
    /** Default {@link NOTEBOOK_TIMEOUT_DEFAULT_S}. */
    timeout_s: timeoutSchema.optional(),
    /**
     * KOBE-805, Run selection: only these lines (1-based, inclusive) of the saved `.py` file, with
     * their common indentation removed. A line past the file's end is not an error (the range
     * stops there); a range that starts past it is.
     */
    lines: notebookLineRangeSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const notebook = body.path.endsWith(".ipynb");
    if (notebook && body.lines !== undefined) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "lines go with a .py file" });
    }
    if (notebook && body.cell_id === undefined) {
      ctx.addIssue({ code: "custom", path: ["cell_id"], message: "a notebook cell id is needed" });
    }
    if (!notebook && body.cell_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["cell_id"], message: "a .py file has no cells" });
    }
  });
export type NotebookRunBody = z.infer<typeof notebookRunBodySchema>;

export const notebookRunResponseSchema = z.strictObject({
  run_id: uuidSchema,
  exec_id: uuidSchema,
});
export type NotebookRunResponse = z.infer<typeof notebookRunResponseSchema>;

/** Most executions `GET .../notebook/executions` lists (KOBE-804 Log). */
export const NOTEBOOK_HISTORY_MAX = 50;

/**
 * One past execution of a file (KOBE-804, the run pane's Log after a reload), from the thread's
 * stored run events (kept until D18 compacts the run, 7 days after it ended): its run, when it
 * started (the event's server time), the `notebook.started` payload and the `notebook.finished`
 * one (null while it runs, or when it never finished), and whether its run has ended (an ended run
 * without `finished` ended before the execution did). Outputs are read one execution at a time.
 */
export const notebookHistoryEntrySchema = z.strictObject({
  run_id: uuidSchema,
  run_ended: z.boolean(),
  started_at: timestampSchema,
  started: notebookStartedPayloadSchema,
  finished: notebookFinishedPayloadSchema.nullable(),
});
export type NotebookHistoryEntry = z.infer<typeof notebookHistoryEntrySchema>;

/**
 * `GET /v1/threads/{id}/notebook/executions?path=` (owner only): the file's last
 * {@link NOTEBOOK_HISTORY_MAX} executions in the thread (a `.py` file's, no cells), newest first.
 */
export const notebookHistoryResponseSchema = z.strictObject({
  executions: z.array(notebookHistoryEntrySchema).max(NOTEBOOK_HISTORY_MAX),
});
export type NotebookHistoryResponse = z.infer<typeof notebookHistoryResponseSchema>;

/** `GET /v1/threads/{id}/notebook/executions/{exec_id}/outputs` (owner only): in order. */
export const notebookExecOutputsResponseSchema = z.strictObject({
  outputs: z.array(notebookOutputSchema).max(NOTEBOOK_EXEC_OUTPUTS_MAX),
});
export type NotebookExecOutputsResponse = z.infer<typeof notebookExecOutputsResponseSchema>;

/** `POST /v1/threads/{id}/notebook/interrupt` and `.../restart` (owner only): 200. */
export const notebookKernelResponseSchema = z.strictObject({
  status: z.enum(["interrupted", "restarted", "idle", "no_kernel"]),
});
export type NotebookKernelResponse = z.infer<typeof notebookKernelResponseSchema>;

/** The kernel once started (KOBE-477): `busy` while it runs a cell. */
const kernelLiveSchema = z.strictObject({ status: z.enum(["idle", "busy"]) });

/**
 * `POST /v1/threads/{id}/notebook/start` (owner only, KOBE-477): 202 `waking` while the sandbox
 * wakes (ask again after `retry_after_ms`), then 200 `idle` / `busy` once the kernel is up.
 */
export const notebookStartResponseSchema = z.union([
  z.strictObject({
    status: z.literal("waking"),
    retry_after_ms: z.number().int().min(100).max(60_000),
  }),
  kernelLiveSchema,
]);
export type NotebookStartResponse = z.infer<typeof notebookStartResponseSchema>;

export const NOTEBOOK_ERROR_CODES = [
  "invalid_request",
  "thread_not_found",
  "not_found", // no synced file at that path
  "not_a_notebook", // the .ipynb is not nbformat 4 JSON
  "cell_not_found",
  "not_code_cell",
  "too_large", // the file or the code is over its limit
  "thread_busy", // the thread has an active run (NB6)
  "sandbox_unavailable",
  "notebooks_unsupported", // the sandbox's agent has no kernel
  "isolation_unavailable",
  "sandbox_refused", // the sandbox could not be woken (KOBE-477): no runtime, not ready in time
  "rate_limited", // too many kernel starts (KOBE-477), variable snapshots (KOBE-803)
  "variables_unsupported", // the sandbox's agent takes no variable snapshots yet (KOBE-803)
] as const;
export const notebookErrorSchema = z.strictObject({
  code: z.enum(NOTEBOOK_ERROR_CODES),
  message: z.string().max(2000),
});
export type NotebookError = z.infer<typeof notebookErrorSchema>;

// ----------------------------------------------------------------------------- run_python (NB13)

const CONTROL = /[\u0000-\u001f\u007f]/u; // eslint-disable-line no-control-regex

/** Model-facing input: `code`, or a `path` (`.py`, or `.ipynb` with `cell_id`). */
export const runPythonInputSchema = z
  .strictObject({
    code: text
      .min(1)
      .refine((s) => utf8ByteLength(s) <= NOTEBOOK_CODE_MAX_BYTES, "code too large")
      .optional(),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !CONTROL.test(p), "control character in path")
      .refine((p) => !p.split("/").includes(".."), "path traversal")
      .refine((p) => p.endsWith(".py") || p.endsWith(".ipynb"), "an .ipynb or .py file")
      .optional(),
    cell_id: notebookCellIdSchema.optional(),
    timeout_s: timeoutSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.code === undefined) === (input.path === undefined)) {
      ctx.addIssue({ code: "custom", message: "give either code or path" });
      return;
    }
    const notebook = input.path?.endsWith(".ipynb") === true;
    if (notebook !== (input.cell_id !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["cell_id"],
        message: "cell_id goes with an .ipynb path, and only with it",
      });
    }
  });
export type RunPythonInput = z.infer<typeof runPythonInputSchema>;

export const notebookToolInputSchema = { [RUN_PYTHON_TOOL]: runPythonInputSchema } as const;

export const notebookCallShape = {
  tool: z.literal(RUN_PYTHON_TOOL),
  input: runPythonInputSchema,
} as const;

/** kobe-tools request (fd 4); member of `kobeToolsRequestSchema`. */
export const notebookToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("notebook.run"),
  tool_call_id: idSchema,
  ...notebookCallShape,
});
export type NotebookToolsRequest = z.infer<typeof notebookToolsRequestSchema>;

/** Success answer (frame and kobe-tools response, flat): the execution ran; `status` says how. */
export const notebookRunOkFields = {
  ok: z.literal(true),
  op: z.literal("notebook_run"),
  status: notebookExecStatusSchema,
  execution_count: z.number().int().nonnegative().nullable(),
  /** For the model: stdout/stderr, results as text, the error; images and HTML as a note. */
  text: z
    .string()
    .refine((s) => utf8ByteLength(s) <= NOTEBOOK_TOOL_TEXT_MAX_BYTES, "text too large"),
  truncated: z.boolean(),
  saved: notebookSavedSchema.nullable(),
} as const;

/** Server answer codes; open on the sandbox side. */
export const NOTEBOOK_RUN_ERROR_CODES = [
  "not_allowed",
  "invalid_path",
  "not_found",
  "not_a_notebook",
  "cell_not_found",
  "not_code_cell",
  "too_large",
  "kernel_unavailable",
  "storage_failed",
] as const;

export const notebookRunFailFields = {
  ok: z.literal(false),
  error: z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message: z.string().max(2000),
  }),
} as const;

// ----------------------------------------------------------------------------- command results

/** `command.result.data` of `notebook.execute` (sandbox -> server). */
export const notebookExecuteResultSchema = z.strictObject({
  status: notebookExecStatusSchema.exclude(["failed"]),
  execution_count: z.number().int().nonnegative().nullable(),
  /** How many `notebook.output` frames the agent sent for it. */
  outputs: z.number().int().min(0).max(NOTEBOOK_EXEC_OUTPUTS_MAX),
  truncated: z.boolean(),
  /** KOBE-803: only when the frame asked (`with_timing`) and the code ran. */
  timing: notebookTimingSchema.optional(),
});
export type NotebookExecuteResult = z.infer<typeof notebookExecuteResultSchema>;

/** `command.result.data` of `notebook.inspect` (KOBE-803). */
export const notebookInspectResultSchema = notebookVariablesResultSchema;

/** `command.result.data` of `notebook.interrupt` / `notebook.restart`. */
export const notebookKernelResultSchema = notebookKernelResponseSchema;

/** `command.result.data` of `notebook.restart` with `op: "start"` (KOBE-477). */
export const notebookStartResultSchema = kernelLiveSchema;
export type NotebookStartResult = z.infer<typeof notebookStartResultSchema>;
