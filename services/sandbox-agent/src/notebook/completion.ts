import { randomUUID } from "node:crypto";
import {
  NOTEBOOK_COMPLETE_TIMEOUT_MS,
  notebookCompletionResultSchema,
  type NotebookCompletionResult,
} from "@kaiju/protocol";
import type { NotebookCompletionFrame } from "@kaiju/protocol/sandbox-wire";
import type { CompleteRequest, KernelSession } from "./session.js";

/**
 * Kernel completion (KOBE-808; the kernel side is `complete` / `doc` in kaiju-kernel-bridge.py):
 * the frame turned into the bridge's request, and the bridge's answer into the wire's result. The
 * answer comes from the member's own kernel, so it is validated against the contract; anything
 * off, late or failed is `unavailable`. The code and the name are never logged.
 */

/** The bridge answers within the request's own timeout; this covers the trip through stdio. */
export const BRIDGE_MARGIN_MS = 250;

export const COMPLETION_UNAVAILABLE: NotebookCompletionResult = { status: "unavailable" };

export function bridgeRequest(frame: NotebookCompletionFrame): CompleteRequest {
  const timeout_ms = frame.timeout_ms ?? NOTEBOOK_COMPLETE_TIMEOUT_MS;
  return frame.op === "complete"
    ? { op: "complete", code: frame.code, cursor: frame.cursor, timeout_ms }
    : { op: "doc", name: frame.name, timeout_ms };
}

/** Asks the (idle) kernel's bridge; never throws. */
export async function askKernel(
  session: KernelSession,
  frame: NotebookCompletionFrame,
  log: (message: string) => void,
): Promise<NotebookCompletionResult> {
  const request = bridgeRequest(frame);
  const got = await session.complete(randomUUID(), request, request.timeout_ms + BRIDGE_MARGIN_MS);
  if (got.kind === "timeout") return COMPLETION_UNAVAILABLE;
  if (got.kind !== "done") {
    // The bridge's own error name ("timeout", "failed", "invalid") or why the kernel went.
    if (got.message !== "timeout") log(`kernel ${frame.op} failed: ${got.message.slice(0, 200)}`);
    return COMPLETION_UNAVAILABLE;
  }
  const parsed = notebookCompletionResultSchema.safeParse(got.result);
  if (!parsed.success || parsed.data.status !== "ok" || parsed.data.op !== frame.op) {
    log(`kernel ${frame.op} answer malformed`);
    return COMPLETION_UNAVAILABLE;
  }
  return parsed.data;
}
