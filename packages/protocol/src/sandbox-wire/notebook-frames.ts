import { z } from "zod";
import { idSchema, utf8ByteLength, uuidSchema } from "../common.js";
import {
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_EXEC_OUTPUTS_MAX,
  NOTEBOOK_TIMEOUT_MAX_S,
  notebookCallShape,
  notebookOutputSchema,
  notebookRunFailFields,
  notebookRunOkFields,
} from "../notebooks.js";
import {
  NOTEBOOK_INSPECT_TIMEOUT_MAX_MS,
  notebookVariableNameSchema,
} from "../notebook-variables.js";
import {
  NOTEBOOK_COMPLETE_TIMEOUT_MAX_MS,
  notebookCompleteFields,
  notebookDocFields,
} from "../notebook-completion.js";
import { codePointLength } from "../semantic-memory/fields.js";
import {
  editorReadCallShape,
  editorReadFailFields,
  editorReadOkFields,
  editorRunCallShape,
} from "../editor-tools.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Notebook frames (KOBE-464, notebooks.ts; docs/specs/notebooks.md), behind hello capability
 * `notebooks`. Three server commands (each answered with `command.result`), the outputs of a
 * running `notebook.execute`, and the `run_python` call kaiju-policy let through.
 */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Server -> sandbox: run `code` in the thread's kernel (started if it has none). Outputs come back
 * as `notebook.output` frames naming this `command_id`; `command.result.data` is a
 * `notebookExecuteResultSchema`. At `timeout_ms` the agent interrupts, then kills the kernel.
 * KOBE-803 (capability `notebook_inspect`, never sent to agents without it): `with_timing` asks for
 * the result's `timing`; `with_variables` asks the agent to take a variables snapshot right after
 * and keep it for `notebook.inspect` (it is never sent back with the result). The delivering
 * replica adds both to a member's run; the agent's `run_python` asks for timing only.
 */
export const notebookExecuteFrameSchema = frame("notebook.execute", {
  command_id: idSchema,
  thread_id: uuidSchema,
  run_id: uuidSchema,
  exec_id: uuidSchema,
  code: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= NOTEBOOK_CODE_MAX_BYTES, "code too large"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(NOTEBOOK_TIMEOUT_MAX_S * 1000),
  with_timing: z.literal(true).optional(),
  with_variables: z.literal(true).optional(),
});

/** Server -> sandbox: SIGINT the thread's kernel. `command.result.data`: `notebookKernelResultSchema`. */
export const notebookInterruptFrameSchema = frame("notebook.interrupt", {
  command_id: idSchema,
  thread_id: uuidSchema,
});

/**
 * Server -> sandbox: kill the thread's kernel (the next execution starts a fresh one). With
 * `op: "start"` (KOBE-477, capability `notebook_start`) instead start it if it has none, keeping a
 * live one; `command.result.data`: `notebookStartResultSchema`.
 */
export const notebookRestartFrameSchema = frame("notebook.restart", {
  command_id: idSchema,
  thread_id: uuidSchema,
  op: z.literal("start").optional(),
});

/**
 * Server -> sandbox (KOBE-803, capability `notebook_inspect`): snapshot the thread's kernel's user
 * variables, silently (no execution count, no history, not a run). Never starts a kernel and never
 * runs while an execution runs or waits. `command.result.data`: `notebookInspectResultSchema`
 * (`no_kernel`, `busy`, or `unavailable` past `timeout_ms`). The agent answers with the snapshot it
 * keeps when code is running (`stale: true`) or nothing ran since it was taken (unless `refresh`),
 * and takes a fresh one otherwise.
 */
export const notebookInspectVariablesFrameSchema = frame("notebook.inspect", {
  command_id: idSchema,
  thread_id: uuidSchema,
  refresh: z.literal(true).optional(),
  timeout_ms: z.number().int().min(500).max(NOTEBOOK_INSPECT_TIMEOUT_MAX_MS).optional(),
  /** KOBE-816: Show: this one variable, its value not withheld (only from a newer agent's hint). */
  show: notebookVariableNameSchema.optional(),
});

const completionTimeout = z
  .number()
  .int()
  .min(100)
  .max(NOTEBOOK_COMPLETE_TIMEOUT_MAX_MS)
  .optional();

/**
 * KOBE-808 (capability `notebook_complete`, never sent to agents without it): the same command
 * with `op: "complete"` (completions at `cursor`, code points into `code`) or `op: "doc"` (the
 * signature and docstring of `name`). Never starts a kernel, never waits for running code (`busy`),
 * `unavailable` past `timeout_ms`. `command.result.data`: `notebookCompletionResultSchema`.
 */
export const notebookCompleteFrameSchema = frame("notebook.inspect", {
  command_id: idSchema,
  thread_id: uuidSchema,
  ...notebookCompleteFields,
  timeout_ms: completionTimeout,
}).refine((f) => f.cursor <= codePointLength(f.code), "cursor past the end of the code");

export const notebookDocFrameSchema = frame("notebook.inspect", {
  command_id: idSchema,
  thread_id: uuidSchema,
  ...notebookDocFields,
  timeout_ms: completionTimeout,
});

export const notebookInspectFrameSchema = z.union([
  notebookInspectVariablesFrameSchema,
  notebookCompleteFrameSchema,
  notebookDocFrameSchema,
]);

/** Sandbox -> server: the `index`-th output of the `notebook.execute` this `command_id` names. */
export const notebookOutputFrameSchema = frame("notebook.output", {
  command_id: idSchema,
  thread_id: uuidSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(NOTEBOOK_EXEC_OUTPUTS_MAX - 1),
  output: notebookOutputSchema,
});

const runIds = {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
} as const;

/**
 * Sandbox -> server: the `run_python` call kaiju-policy let through (a path was pushed first), or
 * KOBE-848's `editor_run` (the member's open `.py` file, pushed first). Answered by
 * `notebook.run_result` for the same `request_id` once the execution ended.
 */
export const notebookRunFrameSchema = z.union([
  frame("notebook.run", { ...runIds, ...notebookCallShape }),
  frame("notebook.run", { ...runIds, ...editorRunCallShape }),
]);

/**
 * Sandbox -> server (KOBE-848, behind `notebooks`): the `editor_read` call kaiju-policy let
 * through. Answered by `editor.read_result` for the same `request_id`.
 */
export const editorReadFrameSchema = frame("editor.read", { ...runIds, ...editorReadCallShape });

/** Server -> sandbox; `error.code` is open (known: `EDITOR_READ_ERROR_CODES`). */
export const editorReadResultFrameSchema = z.union([
  frame("editor.read_result", { request_id: idSchema, ...editorReadOkFields }),
  frame("editor.read_result", { request_id: idSchema, ...editorReadFailFields }),
]);

/** Server -> sandbox; `error.code` is open (known: `NOTEBOOK_RUN_ERROR_CODES`). */
export const notebookRunResultFrameSchema = z.union([
  frame("notebook.run_result", { request_id: idSchema, ...notebookRunOkFields }),
  frame("notebook.run_result", { request_id: idSchema, ...notebookRunFailFields }),
]);

export type NotebookExecuteFrame = z.infer<typeof notebookExecuteFrameSchema>;
export type NotebookInterruptFrame = z.infer<typeof notebookInterruptFrameSchema>;
export type NotebookRestartFrame = z.infer<typeof notebookRestartFrameSchema>;
export type NotebookInspectFrame = z.infer<typeof notebookInspectFrameSchema>;
export type NotebookCompletionFrame =
  z.infer<typeof notebookCompleteFrameSchema> | z.infer<typeof notebookDocFrameSchema>;
export type NotebookOutputFrame = z.infer<typeof notebookOutputFrameSchema>;
export type NotebookRunFrame = z.infer<typeof notebookRunFrameSchema>;
export type NotebookRunResultFrame = z.infer<typeof notebookRunResultFrameSchema>;
export type EditorReadFrame = z.infer<typeof editorReadFrameSchema>;
export type EditorReadResultFrame = z.infer<typeof editorReadResultFrameSchema>;
