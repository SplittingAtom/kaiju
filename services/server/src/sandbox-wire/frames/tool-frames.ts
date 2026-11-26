import { type NotebookExecuteFrame } from "@kaiju/protocol/sandbox-wire";
import type { AllowedArtifactCalls } from "../../artifacts/allowed.js";
import type { RecalledItems } from "../../memory/recalled.js";
import { fileEditProposeSpec } from "../file-edit-propose.js";
import { editorReadSpec } from "../editor-read.js";
import { fileOpenSpec } from "../file-open.js";
import type { InFlight, ToolFrameSpecs } from "../gated-frame.js";
import { notebookRunSpec } from "../notebook-run.js";
import { projectCommitSpec } from "../project-commit.js";
import { skillDraftSaveSpec } from "../skill-draft-save.js";
import type { CommandOutcome } from "../types.js";
import { artifactPutSpec, fileShareSpec } from "./artifacts-files.js";
import { memoryPutSpec, memoryReadSpec, memoryShowSpec } from "./memory.js";
import type { ConnectionPort } from "./port.js";

/** What one connection lends its tool frames beyond the port. */
export interface ToolFrameDeps {
  readonly port: ConnectionPort;
  /** In-flight counters, one per kind (memory: one for all three kinds). */
  readonly inFlight: {
    readonly artifacts: InFlight;
    readonly fileShares: InFlight;
    readonly memory: InFlight;
    readonly skillDrafts: InFlight;
  };
  readonly allowed: Pick<AllowedArtifactCalls, "ruleAllowed">;
  readonly recalled: RecalledItems;
  /** Projects with an agent commit waiting for approval on this connection. */
  readonly pendingCommits: Set<string>;
  /** Aborts pending approvals (memory, commits) when the connection ends. */
  readonly signal: AbortSignal;
  /** The agent's hello capabilities (KOBE-767). */
  hasCapability?(name: string): boolean;
  /** Sends a `notebook.execute` on this connection and resolves with its answer. */
  notebookExecute(frame: NotebookExecuteFrame, timeoutMs: number): Promise<CommandOutcome>;
  /** KOBE-848: a variables snapshot of the thread's kernel on this connection (`editor_read`). */
  notebookInspect(threadId: string, timeoutMs: number, waitMs: number): Promise<CommandOutcome>;
}

/** Every tool frame kind's spec for one connection; dispatched only through the gate. */
export function toolFrameSpecs(d: ToolFrameDeps): ToolFrameSpecs {
  const { port } = d;
  const { ctx, target } = port;
  const memory = { port, inFlight: d.inFlight.memory, recalled: d.recalled, signal: d.signal };
  return {
    "artifact.put": artifactPutSpec(port, d.inFlight.artifacts),
    "file.share": fileShareSpec(port, d.inFlight.fileShares),
    "memory.put": memoryPutSpec(memory),
    "memory.read": memoryReadSpec(memory),
    "memory.show": memoryShowSpec(memory),
    "project.commit": projectCommitSpec({
      deps: ctx.projectCommits,
      target,
      connectionId: port.connectionId,
      ruleAllowed: (frame) => d.allowed.ruleAllowed(frame.run_id, frame.tool_call_id),
      pending: d.pendingCommits,
      signal: d.signal,
      hasCapability: (name) => d.hasCapability?.(name) === true,
      send: (out) => port.send(out),
    }),
    "file.edit_propose": fileEditProposeSpec({
      db: ctx.db,
      target,
      runMaxEvents: ctx.tuning.runMaxEvents,
      log: port.log,
      send: (out) => port.send(out),
    }),
    "file.open": fileOpenSpec({
      db: ctx.db,
      target,
      runMaxEvents: ctx.tuning.runMaxEvents,
      log: port.log,
      send: (out) => port.send(out),
    }),
    "notebook.run": notebookRunSpec({
      db: ctx.db,
      target,
      files: ctx.notebooks,
      log: port.log,
      auditEditor: (t, e) => ctx.auditEditor(t, e),
      execute: (frame, timeoutMs) => d.notebookExecute(frame, timeoutMs),
      send: (out) => port.send(out),
    }),
    "editor.read": editorReadSpec({
      db: ctx.db,
      target,
      log: port.log,
      auditEditor: (t, e) => ctx.auditEditor(t, e),
      inspect: (threadId, timeoutMs, waitMs) => d.notebookInspect(threadId, timeoutMs, waitMs),
      send: (out) => port.send(out),
    }),
    "skill.draft_save": skillDraftSaveSpec({
      ctx,
      target,
      sandboxId: port.sandboxId,
      log: port.log,
      inFlight: d.inFlight.skillDrafts,
      send: (out) => port.send(out),
    }),
  };
}
