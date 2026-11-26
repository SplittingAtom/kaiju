import { z } from "zod";
import { idSchema, utf8ByteLength } from "./common.js";
import { NOTEBOOK_TIMEOUT_MAX_S, notebookRunFailFields } from "./notebooks.js";

/**
 * Editor tools (KOBE-848): the agent runs the `.py` file the member has open in the centre-rail
 * code editor, the same way the editor's Run does, and reads that file's run pane (Run Output,
 * Log, Variables). Registered with the `notebooks` capability (the same kernel as `run_python`).
 *
 * - `editor_run` rides the `notebook.run` frame and kaiju-tools op (notebooks.ts) with
 *   `tool: "editor_run"`: the agent pushes the file, the server reads the synced copy, records
 *   `notebook.started {origin: "agent"}` and runs it in the thread's kernel, so the member sees
 *   the run in the run pane. A write: it asks in `ask-on-write` (tools.ts, scope `kaiju`).
 * - `editor_read` has its own frame (`editor.read`, answered by `editor.read_result`): the server
 *   builds a bounded text; the extension fences it as untrusted. A read: never asks.
 *
 * Both work only on the run's viewed file (`runs.viewing.path`, a `.py` file): the server's
 * editor-file guard denies any other path in every mode. Never in a skill eval run.
 */
export const EDITOR_RUN_TOOL = "editor_run";
export const EDITOR_READ_TOOL = "editor_read";

/** What `editor_read` reads: the run pane's three tabs. */
export const EDITOR_READ_WHATS = ["output", "log", "variables"] as const;
export type EditorReadWhat = (typeof EDITOR_READ_WHATS)[number];

/** Largest `editor_read` answer text (UTF-8 bytes), before the extension's fence. */
export const EDITOR_READ_TEXT_MAX_BYTES = 16 * 1024;
/** Runs `editor_read {what: "log"}` lists, newest first. */
export const EDITOR_LOG_MAX_ENTRIES = 10;
/** Variables `editor_read {what: "variables"}` describes (then a count of the rest). */
export const EDITOR_VARIABLES_MAX = 50;
/** Longest variable preview the model gets (characters, an ellipsis included). */
export const EDITOR_PREVIEW_MAX_CHARS = 80;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** A `.py` path as the model names it (absolute under `/workspace`, or relative). */
export const editorPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !CONTROL.test(p), "control character in path")
  .refine((p) => !p.split("/").includes(".."), "path traversal")
  .refine((p) => p.endsWith(".py"), "a .py file");

/** Model-facing input of `editor_run`: the open file, and an optional timeout. */
export const editorRunInputSchema = z.strictObject({
  path: editorPathSchema,
  timeout_s: z.number().int().min(1).max(NOTEBOOK_TIMEOUT_MAX_S).optional(),
});
export type EditorRunInput = z.infer<typeof editorRunInputSchema>;

/** Model-facing input of `editor_read`. */
export const editorReadInputSchema = z.strictObject({
  path: editorPathSchema,
  what: z.enum(EDITOR_READ_WHATS),
});
export type EditorReadInput = z.infer<typeof editorReadInputSchema>;

export const editorToolInputSchema = {
  [EDITOR_RUN_TOOL]: editorRunInputSchema,
  [EDITOR_READ_TOOL]: editorReadInputSchema,
} as const;

/** `editor_run` on the `notebook.run` frame and kaiju-tools op (notebooks.ts). */
export const editorRunCallShape = {
  tool: z.literal(EDITOR_RUN_TOOL),
  input: editorRunInputSchema,
} as const;

export const editorReadCallShape = {
  tool: z.literal(EDITOR_READ_TOOL),
  input: editorReadInputSchema,
} as const;

/** kaiju-tools request (fd 4) of `editor_run`: the `notebook.run` op; in `kaijuToolsRequestSchema`. */
export const editorRunToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("notebook.run"),
  tool_call_id: idSchema,
  ...editorRunCallShape,
});
export type EditorRunToolsRequest = z.infer<typeof editorRunToolsRequestSchema>;

/** kaiju-tools request (fd 4) of `editor_read`; member of `kaijuToolsRequestSchema`. */
export const editorReadToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("editor.read"),
  tool_call_id: idSchema,
  ...editorReadCallShape,
});
export type EditorReadToolsRequest = z.infer<typeof editorReadToolsRequestSchema>;

/** Success answer (frame and kaiju-tools response, flat): the text the model gets, unfenced. */
export const editorReadOkFields = {
  ok: z.literal(true),
  op: z.literal("editor_read"),
  what: z.enum(EDITOR_READ_WHATS),
  text: z.string().refine((s) => utf8ByteLength(s) <= EDITOR_READ_TEXT_MAX_BYTES, "text too large"),
  truncated: z.boolean(),
} as const;

export const editorReadFailFields = notebookRunFailFields;

/** Server answer codes of `editor.read`; open on the sandbox side. */
export const EDITOR_READ_ERROR_CODES = [
  "not_allowed",
  "invalid_path",
  "variables_unsupported", // the agent takes no variable snapshots (no `notebook_inspect`)
  "rate_limited", // too many variable reads (the owner route's limit, counted apart)
  "storage_failed",
] as const;

// ----------------------------------------------------------------- variable values (KOBE-848 M1)

/**
 * Whether `editor_read {what: "variables"}` shows the agent the values of strings, bytes and
 * containers (Chris, 2026-11-26). Off by default: the agent then gets names, types, lengths,
 * shapes and dtypes, and only the values of numbers, bools and None; the result says when values
 * were withheld. On: an 80-character preview of each value, credential-like names still hidden.
 * The Site sets the default; a team turns it on or off, or follows the Site (`null`).
 */
export const DEFAULT_AGENT_VARIABLE_VALUES = false;

/** `GET`/`PUT /v1/site/policy/agent-variable-values`: the Site default. */
export const siteAgentVariableValuesSchema = z.strictObject({ enabled: z.boolean() });
export type SiteAgentVariableValues = z.infer<typeof siteAgentVariableValuesSchema>;

/** `PUT /v1/team/policy/agent-variable-values`: on, off, or `null` to follow the Site default. */
export const teamAgentVariableValuesBodySchema = z.strictObject({
  enabled: z.boolean().nullable(),
});
export type TeamAgentVariableValuesBody = z.infer<typeof teamAgentVariableValuesBodySchema>;

/** `GET /v1/team/policy/agent-variable-values` (and the `PUT` answer). */
export const teamAgentVariableValuesSchema = z.strictObject({
  site: z.boolean(),
  team: z.boolean().nullable(),
  effective: z.boolean(),
});
export type TeamAgentVariableValues = z.infer<typeof teamAgentVariableValuesSchema>;
