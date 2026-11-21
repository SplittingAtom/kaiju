import { z } from "zod";
import {
  approvalModeSchema,
  idSchema,
  SYSTEM_PROMPT_MAX_BYTES,
  utf8ByteLength,
  uuidSchema,
} from "../../common.js";
import { APP_CARDS_PER_RUN_MAX, appCardEntrySchema } from "../../app-cards.js";
import { runViewingContextSchema } from "../../file-editor.js";
import { runMemoryContextSchema } from "../../memory.js";
import { runProjectContextSchema } from "../../projects.js";
import { runTokenGrantSchema } from "../../run-token.js";
import { SYNC_CONFLICT_NOTES_MAX, syncConflictSchema } from "../../sync-conflicts.js";
import { connectorNameSchema } from "../../tools.js";
import { UPLOAD_MAX_FILES_PER_MESSAGE, uploadFileNameSchema } from "../../uploads.js";
import { runMcpContextSchema } from "../mcp-config.js";
import { SKILL_BUNDLES_MAX, skillBundleRefSchema } from "../skill-bundles.js";
import { wireTraceContextSchema } from "../trace-frames.js";
import { gatewayModelSchema, modelLimitsSchema, piModelApiSchema } from "./model.js";
import { commandId, frame, openCode } from "./wire.js";

/**
 * How the agent configures a thread's Pi process. SPECULATIVE values (owned by KOBE-41 model wiring,
 * KOBE-47 agent resolution, KOBE-62 MCP wiring); the shape is strict and carries **no URLs and no
 * credentials**: the model gateway and MCP proxy base URLs come from the sandbox's environment
 * (Helm), and the agent builds `<KOBE_MCP_PROXY_URL>/v1/mcp/<connector_id>` itself, so a server bug
 * or a forged frame cannot point Pi at an arbitrary endpoint.
 */
/**
 * Unknown keys are ignored (stripped), not rejected, since KOBE-82: a future additive field must not
 * break an older agent. Known fields stay strictly validated; the frame itself is still strict.
 */
export const piThreadConfigSchema = z.object({
  /**
   * The run's model (D30): the catalog alias plus, resolved by the server from the catalog
   * (KOBE-41), the gateway's model id and API style. Without `gateway_model` the sandbox has no
   * model to offer Pi (the run fails `model_not_configured`).
   */
  model: z
    .strictObject({
      alias: z.string().min(1).max(128),
      gateway_model: gatewayModelSchema.optional(),
      api: piModelApiSchema.optional(),
    })
    .optional(),
  /** The model's output limit and context window (KOBE-259); absent from older servers. */
  model_limits: modelLimitsSchema.optional(),
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  agent: z
    .strictObject({ agent_id: uuidSchema, version: z.number().int().positive() })
    .nullable()
    .optional(),
  /** At most `SYSTEM_PROMPT_MAX_BYTES` UTF-8 bytes: the same limit as the agent file's prompt. */
  system_prompt: z
    .string()
    .refine((s) => utf8ByteLength(s) <= SYSTEM_PROMPT_MAX_BYTES, {
      message: `system_prompt is over ${SYSTEM_PROMPT_MAX_BYTES} bytes`,
    })
    .optional(),
  /** Names of the run's effective skills (D22); the bytes are `skill_bundles`. */
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/))
    .max(64)
    .optional(),
  /**
   * The bytes behind `skills` (KOBE-82, skill-bundles.ts): the canonical zip's hash and size per
   * effective skill. The sandbox materializes exactly these and nothing else. Absent = none.
   */
  skill_bundles: z.array(skillBundleRefSchema).max(SKILL_BUNDLES_MAX).optional(),
  /** Connectors to expose; Pi tool names become `mcp__<name>__<tool>` (verified Pi 1.0.0). */
  mcp_servers: z
    .array(z.strictObject({ name: connectorNameSchema, connector_id: uuidSchema }))
    .max(64)
    .optional(),
  approval_mode: approvalModeSchema.optional(),
});
export type PiThreadConfig = z.infer<typeof piThreadConfigSchema>;

/** One uploaded file as the agent sees it (`run.start.attachments`). */
export const sandboxAttachmentSchema = z.strictObject({
  /**
   * Absolute path of the synced file, normally `{@link UPLOAD_ATTACHMENT_ROOT}/<thread>/<name>`.
   * The schema only rejects `..` segments: the agent's workspace root is configurable and the agent
   * refuses paths outside it (`pi_rejected`), so the exact root is not part of the wire shape.
   */
  path: z
    .string()
    .min(1)
    .refine((p) => !p.split("/").includes(".."), "path traversal"),
  mime_type: z.string().min(1),
  /** Original file name, for the prompt; absent in frames from older servers. */
  name: uploadFileNameSchema.optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  /**
   * Hint that the model supports this media natively: the agent MAY pass the file to Pi as an
   * image / document block (read from `path`) in addition to listing it. Absent = text path only.
   */
  native_media: z.enum(["image", "pdf"]).optional(),
});
export type SandboxAttachment = z.infer<typeof sandboxAttachmentSchema>;

/** Start a run: spawn/reuse the thread's `pi --mode rpc` process and send Pi `prompt`. */
export const runStartFrameSchema = frame("run.start", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  message: z.string(),
  /**
   * Uploaded files already synced into the sandbox (KOBE-141, uploads.ts); absent = none. Older
   * servers send only `path` and `mime_type`.
   */
  attachments: z.array(sandboxAttachmentSchema).max(UPLOAD_MAX_FILES_PER_MESSAGE).optional(),
  /** Branch point for edit-and-regenerate; absent = continue from the thread's leaf. */
  parent_entry_id: idSchema.optional(),
  config: piThreadConfigSchema.optional(),
  /**
   * Run-bound model-gateway token (KOBE-117, run-token.ts): bound to this run, delivered to this
   * thread's Pi only (the agent must not write it to disk or env, nor expose it to tools), sent
   * as `x-kobe-run-token`. Sent only to agents whose `hello.capabilities` lists
   * `CAPABILITY_RUN_TOKEN`; absent = legacy (session token + advisory `x-kobe-run-id`).
   */
  run_token: runTokenGrantSchema.optional(),
  /** Memory indexes and enabled scopes (KOBE-153, memory.ts); only for agents with capability `memory`. */
  memory: runMemoryContextSchema.optional(),
  /** Project id, name and instructions (KOBE-159, projects.ts); only for agents with capability `projects`. */
  project: runProjectContextSchema.optional(),
  /** The run's effective MCP connectors (KOBE-111, mcp-config.ts); only for agents with capability `mcp`. */
  mcp: runMcpContextSchema.optional(),
  /**
   * The workspace file the member had open when sending (KOBE-462, file-editor.ts): fenced as
   * untrusted data in this run's system prompt only. Only for agents with capability `file_edits`.
   */
  viewing: runViewingContextSchema.optional(),
  /**
   * Workspace sync conflicts of this thread the agent was not told about yet (KOBE-492,
   * sync-conflicts.ts): names and hashes, fenced as a note in this run's system prompt only. Only
   * for agents with capability `sync_conflicts`.
   */
  sync_conflicts: z.array(syncConflictSchema).max(SYNC_CONFLICT_NOTES_MAX).optional(),
  /**
   * The run's trace context (KOBE-274, trace-frames.ts): only for agents with capability
   * `trace_spans`, and only when the server traces this run. Absent = record and send no spans.
   */
  trace: wireTraceContextSchema.optional(),
  /**
   * App cards (KOBE-440, app-cards.ts) the thread got since Pi's last entry, oldest first: only for
   * agents with capability `app_cards`. With Pi stopped, the agent appends each one it does not
   * have to the thread's session before the branch marker, so the model sees them in this run.
   */
  app_cards: z.array(appCardEntrySchema).max(APP_CARDS_PER_RUN_MAX).optional(),
});

/** Pi `steer`: delivered after the current turn's tool calls, before the next model call. */
export const runSteerFrameSchema = frame("run.steer", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  message: z.string().min(1),
});

/**
 * `abort` = Pi `abort` now (Stop). `after_step` = let the in-flight model step and its tool calls
 * finish (`turn_end`), then abort (D30 budget stop).
 */
export const runStopFrameSchema = frame("run.stop", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  mode: z.enum(["abort", "after_step"]),
  /** `user_cancelled` | `budget_exhausted` | `approval_expired` today; open (informational). */
  reason: openCode,
});
