import { piExtensionUiRequestSchema, type PiExtensionUiRequest } from "@kobe/protocol/sandbox-wire";
import {
  BRANCH_SUMMARY_REQUEST_UI_TITLE,
  BRANCH_SUMMARY_RESULT_UI_TITLE,
} from "../kobe-models/branch-summary-protocol.js";
import { RUN_TOKEN_UI_TITLE } from "../kobe-models/protocol.js";
import type { PiProcess, PiRecord } from "../pi/pi-process.js";
import type { BranchSummaryState } from "./branch-summary-state.js";
import { DIALOG_METHODS, MAX_PENDING_DIALOGS, type ThreadHooks } from "./thread-env.js";

/** What `routeUiRequest` reads and changes of its thread (the thread's state, at call time). */
export interface UiRequestPort {
  readonly threadId: string;
  /** The thread's active run, if any. */
  readonly runId: string | undefined;
  /** The active run's gateway token (KOBE-118), memory only. */
  readonly runToken: { readonly runId: string; readonly token: string } | undefined;
  readonly branchSummary: BranchSummaryState;
  /** The thread's open dialogs, by request id. */
  readonly dialogs: Map<string, PiExtensionUiRequest>;
  readonly hooks: Pick<ThreadHooks, "uiRequest" | "diagnostic">;
}

/**
 * One extension UI request from the thread's current Pi: the run token and branch summary
 * channels are answered here and never relayed; any other request is relayed to the server while
 * a run is active (dialogs are tracked, at most {@link MAX_PENDING_DIALOGS}), else cancelled.
 */
export function routeUiRequest(port: UiRequestPort, pi: PiProcess, record: PiRecord): void {
  if (record.method === "input" && record.title === RUN_TOKEN_UI_TITLE) {
    answerRunToken(port, pi, record);
    return;
  }
  // The branch summary's channel (KOBE-548): never relayed, whatever the run.
  if (record.method === "input" && record.title === BRANCH_SUMMARY_REQUEST_UI_TITLE) {
    port.branchSummary.answerRequest(pi, record, port.runId, (message) =>
      port.hooks.diagnostic(port.threadId, message),
    );
    return;
  }
  if (record.method === "input" && record.title === BRANCH_SUMMARY_RESULT_UI_TITLE) {
    port.branchSummary.takeOutcome(pi, record);
    return;
  }
  const parsed = piExtensionUiRequestSchema.safeParse(record);
  if (!parsed.success) {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id !== undefined) pi.send({ type: "extension_ui_response", id, cancelled: true });
    port.hooks.diagnostic(port.threadId, "unsupported extension UI request cancelled");
    return;
  }
  const request = parsed.data;
  const runId = port.runId;
  if (runId === undefined) {
    // The server leases a thread only through a run: with none active nobody may answer.
    if (DIALOG_METHODS.has(request.method)) cancelDialog(pi, request.id);
    return;
  }
  if (DIALOG_METHODS.has(request.method)) {
    if (port.dialogs.size >= MAX_PENDING_DIALOGS) {
      pi.send({ type: "extension_ui_response", id: request.id, cancelled: true });
      return;
    }
    port.dialogs.set(request.id, request);
  }
  port.hooks.uiRequest(port.threadId, runId, request);
}

/**
 * kobe-models asks for the run's gateway token (KOBE-118). Answered here, never relayed to the
 * server: the token for the active run, else a cancel (no run, no token, an older server).
 */
function answerRunToken(port: UiRequestPort, pi: PiProcess, record: PiRecord): void {
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id === undefined) return;
  const held = port.runToken;
  if (held !== undefined && held.runId === port.runId) {
    pi.send({ type: "extension_ui_response", id, value: held.token });
  } else {
    pi.send({ type: "extension_ui_response", id, cancelled: true });
  }
}

export function cancelDialog(pi: PiProcess, id: string): void {
  pi.send({ type: "extension_ui_response", id, cancelled: true });
}
