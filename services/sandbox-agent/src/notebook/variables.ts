import {
  NOTEBOOK_COLUMNS_MAX,
  NOTEBOOK_INSPECT_BUDGET_MS,
  NOTEBOOK_REPR_MAX_CHARS,
  NOTEBOOK_REPR_TIMEOUT_MS,
  NOTEBOOK_VARIABLES_MAX,
  NOTEBOOK_VARIABLES_MAX_BYTES,
  notebookVariablesSnapshotSchema,
  type NotebookVariablesResult,
} from "@kaiju/protocol";
import type { InspectLimits, InspectResult } from "./session.js";

/**
 * Variables snapshots (KOBE-803; the kernel side is `inspect` in kaiju-kernel-bridge.py): the caps
 * the bridge is given, and the bridge's answer turned into the wire's result. The bridge's object
 * comes from the member's own kernel, so it is validated against the contract like any other
 * input; anything off (or no answer) is `unavailable`.
 */
export const INSPECT_LIMITS: InspectLimits = {
  max_vars: NOTEBOOK_VARIABLES_MAX,
  max_bytes: NOTEBOOK_VARIABLES_MAX_BYTES,
  repr_chars: NOTEBOOK_REPR_MAX_CHARS,
  columns_max: NOTEBOOK_COLUMNS_MAX,
  per_var_ms: NOTEBOOK_REPR_TIMEOUT_MS,
  budget_ms: NOTEBOOK_INSPECT_BUDGET_MS,
};

/** How long the snapshot taken after an execution may hold that execution's answer back. */
export const AFTER_RUN_INSPECT_TIMEOUT_MS = 3_000;

export const UNAVAILABLE: NotebookVariablesResult = { status: "unavailable" };

export function snapshotResult(
  got: InspectResult,
  takenAt: Date,
  log: (message: string) => void,
): NotebookVariablesResult {
  if (got.kind !== "done") {
    log(`variables snapshot failed: ${got.message.slice(0, 200)}`);
    return UNAVAILABLE;
  }
  const parsed = notebookVariablesSnapshotSchema.safeParse({
    ...got.snapshot,
    status: "ok",
    taken_at: takenAt.toISOString(),
  });
  if (!parsed.success) {
    log("variables snapshot malformed");
    return UNAVAILABLE;
  }
  return parsed.data;
}
