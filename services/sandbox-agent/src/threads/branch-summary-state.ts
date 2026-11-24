import {
  parseBranchSummaryOutcome,
  type BranchSummaryOutcome,
  type BranchSummaryRequest,
} from "../kaiju-models/branch-summary-protocol.js";
import type { PiProcess, PiRecord } from "../pi/pi-process.js";

/**
 * A branch summary the agent armed for its run (KOBE-548): handed to kaiju-models once, on its
 * request dialog; then the outcome dialog is awaited. Memory only; cleared with the run.
 */
export class BranchSummaryState {
  #armed:
    | {
        readonly runId: string;
        request: BranchSummaryRequest | undefined;
        outcome: BranchSummaryOutcome | undefined;
      }
    | undefined;

  /** Arm one summary for `runId` (the caller checked it is the active run). */
  arm(runId: string, request: BranchSummaryRequest): void {
    this.#armed = { runId, request, outcome: undefined };
  }

  /** The outcome kaiju-models reported for the armed summary (undefined: none came); disarms. */
  take(runId: string): BranchSummaryOutcome | undefined {
    const armed = this.#armed;
    if (armed?.runId !== runId) return undefined;
    this.#armed = undefined;
    return armed.outcome;
  }

  clear(): void {
    this.#armed = undefined;
  }

  /** kaiju-models asks for the armed request: answered once, for `activeRunId` only. */
  answerRequest(
    pi: PiProcess,
    record: PiRecord,
    activeRunId: string | undefined,
    diagnostic: (message: string) => void,
  ): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id === undefined) return;
    const armed = this.#armed;
    const request = armed?.runId === activeRunId ? armed?.request : undefined;
    if (armed !== undefined && request !== undefined) {
      armed.request = undefined; // once
      pi.send({ type: "extension_ui_response", id, value: JSON.stringify(request) });
      return;
    }
    diagnostic("branch summary command refused: not armed by the agent");
    pi.send({ type: "extension_ui_response", id, cancelled: true });
  }

  takeOutcome(pi: PiProcess, record: PiRecord): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id === undefined) return;
    const armed = this.#armed;
    // Only after this run's request was handed out, and only the first outcome.
    if (armed !== undefined && armed.request === undefined && armed.outcome === undefined) {
      armed.outcome = parseBranchSummaryOutcome(record.placeholder);
    }
    pi.send({ type: "extension_ui_response", id, cancelled: true });
  }
}
