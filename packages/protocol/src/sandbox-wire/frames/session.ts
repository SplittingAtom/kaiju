import { z } from "zod";
import { errorInfoSchema, idSchema, timestampSchema, uuidSchema } from "../../common.js";
import {
  piBridgeCommandSchema,
  piExtensionUiRequestSchema,
  piExtensionUiResponseSchema,
  piSessionEntrySchema,
  piSessionEventSchema,
  piSessionHeaderSchema,
} from "../pi-rpc.js";
import { STATE_FOLDER_OUTCOMES } from "../../state-folder.js";
import { commandId, frame, openCode, seq } from "./wire.js";

/** Connection and Pi session frames: hello, Pi events and commands, restore, acks, shutdown. */

// ----------------------------------------------------------------------------- sandbox → server

export const helloFrameSchema = frame("hello", {
  sandbox_id: uuidSchema,
  agent_version: z.string().min(1).max(64),
  /** Installed Pi; the server refuses (close `unsupported_version`) outside 1.4.x and 1.0.x. */
  pi_version: z.string().min(1).max(64),
  /** Runs this agent still has a live Pi process for, with the highest outbound seq sent. */
  runs: z.array(
    z.strictObject({
      run_id: uuidSchema,
      thread_id: uuidSchema,
      last_seq: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Optional features this agent supports (KOBE-82), e.g. `skill_bundles`. Absent = none (older
   * agents). The server sends a feature's fields only to agents that list it. An agent that sends
   * this field needs a server that knows it: roll the server out first.
   */
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .max(32)
    .optional(),
  /**
   * KOBE-827: what the move of the pre-rename folder `/workspace/.kobe` to `.kaiju` did when this
   * agent started; absent when there was nothing to move. `code` is the errno code of a failed
   * move (`EACCES`, ...). Never names a file.
   */
  state_folder: z
    .strictObject({
      outcome: z.enum(STATE_FOLDER_OUTCOMES),
      code: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
        .optional(),
    })
    .optional(),
});

/** One raw Pi session event, bridged unchanged (the server translates to Kaiju events). */
export const piEventFrameSchema = frame("pi.event", {
  run_id: uuidSchema,
  thread_id: uuidSchema,
  seq,
  event: piSessionEventSchema,
});

/**
 * An `extension_ui_request` from Pi, forwarded for the server to answer or cancel. Not sequenced:
 * after a reconnect the agent re-sends every dialog still open, so the server must dedupe by
 * `(thread_id, request.id)` and answer each dialog once (KOBE-23/24).
 */
export const piUiRequestFrameSchema = frame("pi.ui_request", {
  run_id: uuidSchema.optional(),
  thread_id: uuidSchema,
  request: piExtensionUiRequestSchema,
});

/** Exactly one per server command. `data` is the Pi response `data` for `pi.command`. */
export const commandResultFrameSchema = z.union([
  frame("command.result", {
    command_id: commandId,
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  frame("command.result", { command_id: commandId, ok: z.literal(false), error: errorInfoSchema }),
]);

/** A thread's Pi process exited (crash or after shutdown). Active runs on it are lost. */
export const piExitedFrameSchema = frame("pi.exited", {
  thread_id: uuidSchema,
  exit_code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  /** Last stderr lines for diagnostics. Must not contain secrets (there are none in the sandbox). */
  stderr_tail: z.string().max(8192),
});

// ----------------------------------------------------------------------------- server → sandbox

export const helloAckFrameSchema = frame("hello.ack", {
  connection_id: idSchema,
  server_time: timestampSchema,
  heartbeat_interval_ms: z.number().int().positive(),
  /** Server's last durable outbound seq per run the server still considers active on this sandbox. */
  runs: z.array(
    z.strictObject({
      run_id: uuidSchema,
      thread_id: uuidSchema,
      durable_seq: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * Allow-listed Pi RPC command (`get_entries(since)`, `get_state`, ...; never `fork` or `compact`,
 * see pi-rpc.ts); answered with `command.result`.
 */
export const piCommandFrameSchema = frame("pi.command", {
  command_id: commandId,
  thread_id: uuidSchema,
  command: piBridgeCommandSchema,
});

export const piUiResponseFrameSchema = frame("pi.ui_response", {
  thread_id: uuidSchema,
  response: piExtensionUiResponseSchema,
});

/**
 * Rebuild a thread's Pi session JSONL from Postgres (volume lost, D13/D15). Sent in parts, each
 * its own command with its own `command_id`, and **every part gets its own `command.result`**
 * (the server sends the next part after the previous one's result). Part 0 starts (or restarts)
 * the restore and may carry `header` (absent → the agent writes a default one); the agent writes
 * the file only after `final: true`, and a lost connection voids a partial restore (the server
 * starts again from part 0). The agent **rewrites `header.cwd`** to its own workspace directory,
 * whatever the stored header says: Pi 1.0.0 refuses a session whose cwd does not exist.
 * SPECULATIVE chunking (KOBE-24 sends ≤ 2 MiB parts).
 */
export const sessionRestoreFrameSchema = frame("session.restore", {
  command_id: commandId,
  thread_id: uuidSchema,
  part: z.number().int().nonnegative(),
  final: z.boolean(),
  header: piSessionHeaderSchema.optional(),
  entries: z.array(piSessionEntrySchema),
});

/** Cumulative ack: every `pi.event` of `run_id` with seq ≤ `seq` is durable. */
export const ackFrameSchema = frame("ack", { run_id: uuidSchema, seq });

/** Gap on a live socket: re-send this run's `pi.event` frames from `from_seq` (= durable_seq + 1). */
export const resendFrameSchema = frame("resend", { run_id: uuidSchema, from_seq: seq });

/**
 * `hello.capabilities` entry of an agent that applies server moves as local renames (KOBE-304,
 * `workspace-sync.ts` moves) and takes {@link workspaceMovedFrameSchema}.
 */
export const CAPABILITY_WORKSPACE_MOVES = "workspace_moves";

/**
 * The member moved or renamed something in the workspace (KOBE-304): replay the server's moves
 * (`GET moves`) and pull now, rather than at the next interval. A hint only: no answer, no
 * content; sent only to agents that announced {@link CAPABILITY_WORKSPACE_MOVES}. A hibernated
 * sandbox gets none and replays on wake, before its first pull.
 */
export const workspaceMovedFrameSchema = frame("workspace.moved", {});

/** Drain and close: abort nothing in flight unless `deadline_ms` passes. */
export const shutdownFrameSchema = frame("shutdown", {
  /** `hibernate` | `destroy` | `replaced` today; open (informational). */
  reason: openCode,
  deadline_ms: z.number().int().nonnegative(),
});
