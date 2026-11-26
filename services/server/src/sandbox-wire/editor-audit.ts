import type { SandboxTarget } from "./types.js";

/**
 * The `run.editor_*` audit rows of the agent's editor tools (KOBE-848), every outcome included
 * (refusals and failures too: security review L4). Ids and the outcome only, never a path, code,
 * output or value. Written by the replica off the frame path (`WireContext.auditEditor`), never
 * throttled.
 */
export interface EditorRunAudit {
  readonly action: "run.editor_run";
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly status: "ok" | "error" | "interrupted" | "timeout" | "restarted" | "failed" | "refused";
}

export interface EditorReadAudit {
  readonly action: "run.editor_read";
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly what: "output" | "log" | "variables";
  readonly outcome: "ok" | "refused" | "failed";
}

export type EditorAudit = EditorRunAudit | EditorReadAudit;

export type AuditEditor = (target: SandboxTarget, event: EditorAudit) => void;
