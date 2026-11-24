import type { KaijuToolsRequest, KaijuToolsResponse } from "@kaiju/protocol";
import type {
  MemoryPutFrame,
  MemoryReadFrame,
  MemoryResultFrame,
  MemoryShowFrame,
} from "@kaiju/protocol/sandbox-wire";
import { toolsError } from "./channel.js";
import { PendingRequests } from "./pending-requests.js";

/**
 * Routes `remember` / `recall` / `show_memory_item` kobe-tools requests (`memory.put`,
 * `memory.read`, `memory.show` since KOBE-399) to the server and
 * its `memory.result` back (KOBE-157, memory.ts). Same rules as the other brokers: wire ids
 * are minted here, the frame carries the run and thread the agent knows (never ones the extension
 * names) plus the `tool_call_id` kobe-policy allowed, every pending request is answered exactly
 * once, and anything that prevents an answer is an error (fail closed). No retry.
 */
export const MAX_PENDING_MEMORY = 32;
export const MAX_PENDING_MEMORY_PER_THREAD = 4;

type MemoryRequest = Extract<
  KaijuToolsRequest,
  { op: "memory.put" | "memory.read" | "memory.show" }
>;
type MemoryFrame = MemoryPutFrame | MemoryReadFrame | MemoryShowFrame;

export interface MemoryBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: MemoryFrame) => boolean;
}

export class MemoryBroker {
  readonly #deps: MemoryBrokerDeps;
  readonly #pending = new PendingRequests({
    prefix: "mem",
    max: MAX_PENDING_MEMORY,
    maxPerThread: MAX_PENDING_MEMORY_PER_THREAD,
  });

  constructor(deps: MemoryBrokerDeps) {
    this.#deps = deps;
  }

  request(
    threadId: string,
    runId: string | undefined,
    request: MemoryRequest,
    reply: (response: KaijuToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const requestId = this.#pending.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "too many memory requests in flight"));
      return;
    }
    const base = {
      v: 1 as const,
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
    };
    const frame: MemoryFrame =
      request.op === "memory.put"
        ? { ...base, type: "memory.put", input: request.input }
        : request.op === "memory.read"
          ? { ...base, type: "memory.read", input: request.input }
          : { ...base, type: "memory.show", input: request.input };
    if (!this.#deps.send(frame)) {
      this.#pending.fail(requestId, "unavailable", "Kaiju server not reachable");
    }
  }

  /** `memory.result` from the server; false when nothing waits for it. */
  onResult(frame: MemoryResultFrame): boolean {
    const pending = this.#pending.take(frame.request_id);
    if (pending === undefined) return false;
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body } as KaijuToolsResponse);
    return true;
  }

  failAll(message: string): void {
    this.#pending.failAll(message);
  }

  failRun(runId: string, message: string): void {
    this.#pending.failRun(runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#pending.failThread(threadId, message);
  }
}
