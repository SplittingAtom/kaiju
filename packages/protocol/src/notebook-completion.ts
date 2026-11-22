import { z } from "zod";
import { utf8ByteLength } from "./common.js";
import { codePointLength } from "./semantic-memory/fields.js";

/**
 * Code completion from the thread's Python kernel (KOBE-808): the code editor asks the member's
 * own running kernel for completions at the cursor (`op: "complete"`, Jupyter `complete_request`)
 * and for the signature and docstring of a name (`op: "doc"`). Behind hello capability
 * {@link CAPABILITY_NOTEBOOK_COMPLETE}: the server sends these `notebook.inspect` frames only to
 * agents that announced it; an older agent gives the editor its built-in completion only.
 *
 * Neither request runs the member's code. `complete` uses IPython's own completer with jedi off
 * and its default `limited` evaluation (no property getters, no calls, no imports); `doc` resolves
 * a dotted name with `inspect.getattr_static` and reads signatures and docstrings, never a repr.
 * Neither starts a kernel, wakes a sandbox or waits for running code. Nothing is stored: no run
 * event, no audit, and the code is never logged.
 */

/** `hello.capabilities`: the agent answers completion and documentation requests. */
export const CAPABILITY_NOTEBOOK_COMPLETE = "notebook_complete";

/** Most bytes of code one completion request sends (the editor sends a window around the cursor). */
export const NOTEBOOK_COMPLETE_CODE_MAX_BYTES = 32 * 1024;
/** Most matches one answer holds. */
export const NOTEBOOK_COMPLETE_MATCHES_MAX = 100;
/** Longest match text (characters). */
export const NOTEBOOK_COMPLETE_MATCH_MAX_CHARS = 200;
/** Longest match type (`function`, `attribute`, `dict key`, ...). */
export const NOTEBOOK_COMPLETE_TYPE_MAX_CHARS = 32;
/** Longest signature and docstring (characters, an ellipsis included). */
export const NOTEBOOK_SIGNATURE_MAX_CHARS = 1_000;
export const NOTEBOOK_DOC_MAX_CHARS = 8_000;
/** Longest dotted name a `doc` request names, and its form (ASCII identifiers only). */
export const NOTEBOOK_DOC_NAME_MAX_CHARS = 256;
export const NOTEBOOK_DOC_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/;
/** How long the agent waits for the kernel's answer; past it the answer is `unavailable`. */
export const NOTEBOOK_COMPLETE_TIMEOUT_MS = 1_000;
export const NOTEBOOK_COMPLETE_TIMEOUT_MAX_MS = 2_000;

const noNul = (s: string) => !s.includes("\u0000");
const short = (max: number) => z.string().max(max).refine(noNul, "U+0000");

const codeSchema = z
  .string()
  .refine((s) => utf8ByteLength(s) <= NOTEBOOK_COMPLETE_CODE_MAX_BYTES, "code too large")
  .refine(noNul, "U+0000");
const cursorSchema = z.number().int().nonnegative();
const nameSchema = z
  .string()
  .min(1)
  .max(NOTEBOOK_DOC_NAME_MAX_CHARS)
  .regex(NOTEBOOK_DOC_NAME_PATTERN, "a dotted Python name");

/** Completion at `cursor`: code points into `code`, as Jupyter counts it (not UTF-16 units). */
export const notebookCompleteFields = {
  op: z.literal("complete"),
  code: codeSchema,
  cursor: cursorSchema,
};
/** Signature and docstring of the dotted name `name` in the kernel's namespace. */
export const notebookDocFields = { op: z.literal("doc"), name: nameSchema };

const cursorInCode = (r: { op: string; code?: string; cursor?: number }) =>
  r.op !== "complete" || (r.cursor ?? 0) <= codePointLength(r.code ?? "");

/** `POST /v1/threads/{id}/notebook/complete` body. */
export const notebookCompletionBodySchema = z
  .union([z.strictObject(notebookCompleteFields), z.strictObject(notebookDocFields)])
  .refine(cursorInCode, "cursor past the end of the code");
export type NotebookCompletionBody = z.infer<typeof notebookCompletionBodySchema>;

export const notebookCompletionMatchSchema = z.strictObject({
  text: short(NOTEBOOK_COMPLETE_MATCH_MAX_CHARS).min(1),
  /** The kernel's kind for it, when it gives one. */
  type: short(NOTEBOOK_COMPLETE_TYPE_MAX_CHARS).min(1).optional(),
});
export type NotebookCompletionMatch = z.infer<typeof notebookCompletionMatchSchema>;

/** Matches replace the code between `cursor_start` and `cursor_end` (code points). */
export const notebookCompleteOkSchema = z
  .strictObject({
    status: z.literal("ok"),
    op: z.literal("complete"),
    matches: z.array(notebookCompletionMatchSchema).max(NOTEBOOK_COMPLETE_MATCHES_MAX),
    cursor_start: z.number().int().nonnegative(),
    cursor_end: z.number().int().nonnegative(),
  })
  .refine((r) => r.cursor_start <= r.cursor_end, "cursor_start after cursor_end");

/**
 * `found`: the name resolves in the kernel. `signature` (callables: `name(args)`), `doc` (the
 * docstring, else the type's) and `type` (the object's type name), all plain text.
 */
export const notebookDocOkSchema = z.strictObject({
  status: z.literal("ok"),
  op: z.literal("doc"),
  found: z.boolean(),
  signature: short(NOTEBOOK_SIGNATURE_MAX_CHARS).optional(),
  doc: short(NOTEBOOK_DOC_MAX_CHARS).optional(),
  type: short(256).optional(),
});

/**
 * No answer: `busy` (code runs or waits, or another request is in the kernel), `no_kernel` (none
 * is running; none is started), `unavailable` (no answer in time, or the kernel failed it). Only
 * the server answers `asleep` (the sandbox is not connected; it is never woken for this) and
 * `unsupported` (the sandbox agent is older than this feature).
 */
export const notebookCompletionMissingSchema = z.strictObject({
  status: z.enum(["busy", "no_kernel", "unavailable", "asleep", "unsupported"]),
});

/**
 * `command.result.data` of a completion `notebook.inspect`, and the answer of
 * `POST /v1/threads/{id}/notebook/complete`.
 */
export const notebookCompletionResultSchema = z.union([
  notebookCompleteOkSchema,
  notebookDocOkSchema,
  notebookCompletionMissingSchema,
]);
export type NotebookCompletionResult = z.infer<typeof notebookCompletionResultSchema>;
export type NotebookCompletionStatus = NotebookCompletionResult["status"];
