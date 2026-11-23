"use client";

/**
 * How an execution ended, in words (KOBE-465; statuses NB15, save errors NB11). KOBE-805: a run
 * cut at the output cap or stopped at its time limit says so plainly, with what to do.
 */
import { NOTEBOOK_EXEC_OUTPUTS_MAX, NOTEBOOK_EXEC_OUTPUT_MAX_BYTES } from "@kobe/protocol";
import type { Execution } from "../../lib/notebooks/executions";
import { formatBytes } from "../../lib/files/format";

export const TIMEOUT_NOTE =
  "Stopped: it ran past its time limit. Make it faster, or run it in smaller parts (Run selection).";
export const TRUNCATED_NOTE = `Some output was cut: a run keeps at most ${NOTEBOOK_EXEC_OUTPUTS_MAX} outputs and ${formatBytes(NOTEBOOK_EXEC_OUTPUT_MAX_BYTES)}. Print less, or write large results to a file and open that.`;

const STATUS: Readonly<Record<string, string>> = {
  interrupted: "Interrupted.",
  timeout: TIMEOUT_NOTE,
  restarted: "Stopped: the kernel restarted.",
  failed: "The sandbox could not run this.",
};

const SAVE_ERROR: Readonly<Record<string, string>> = {
  version_conflict: "the notebook changed meanwhile",
  cell_not_found: "the cell is no longer in the saved notebook",
  read_only: "the file is read-only",
};

/** What to say about an execution beyond its outputs; null: nothing (running, or plain ok). */
export function executionNote(exec: Execution, notebook: boolean): string | null {
  const end = exec.finished;
  if (end === undefined) return null;
  const parts: string[] = [];
  const status = STATUS[end.status];
  if (status) parts.push(status);
  if (end.truncated) parts.push(TRUNCATED_NOTE);
  if (notebook && end.saved === null && end.status !== "failed") {
    const why = end.saveError ? (SAVE_ERROR[end.saveError] ?? end.saveError) : null;
    parts.push(
      why ? `The outputs were not saved to the notebook: ${why}.` : "The outputs were not saved.",
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

export function ExecutionNote({
  exec,
  notebook,
}: {
  readonly exec: Execution;
  readonly notebook: boolean;
}) {
  const running = exec.finished === undefined;
  const text = running ? "Running…" : executionNote(exec, notebook);
  if (text === null) return null;
  return (
    <p role="status" className="text-muted-foreground text-xs" data-kobe-exec-status="">
      {exec.origin === "agent" ? `Agent run: ${text}` : text}
    </p>
  );
}
