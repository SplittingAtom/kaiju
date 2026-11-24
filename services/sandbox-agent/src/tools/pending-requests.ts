import type { KaijuToolsResponse } from "@kaiju/protocol";
import { toolsError } from "./channel.js";

/**
 * The requests one tool broker has sent (or is about to send) to the server and not yet answered.
 * Shared by every broker in this folder, so the rules live in one place: wire `request_id`s are
 * minted here (`<prefix>_<n>`, never reused), so two threads' extensions can never collide or
 * answer each other's requests; a request is admitted only under the broker's global and
 * per-thread caps; and every admitted request is answered exactly once, because whatever answers
 * it (the server's result, a failure on the way, a run or thread ending, a lost connection) first
 * removes it, and a second answer finds nothing.
 */
export interface PendingRequest {
  readonly threadId: string;
  readonly runId: string;
  /** The extension's own request id, which its answer carries. */
  readonly extensionId: string;
  readonly reply: (response: KaijuToolsResponse) => void;
}

export interface PendingRequestsOptions {
  /** Wire id prefix, e.g. `ap` for `ap_1`. */
  readonly prefix: string;
  /** Most requests in flight across all threads. */
  readonly max: number;
  /** Most requests in flight for one thread. */
  readonly maxPerThread: number;
}

export class PendingRequests {
  readonly #options: PendingRequestsOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #next = 1;

  constructor(options: PendingRequestsOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Admit a request and mint its wire id; undefined (and no id used) when a cap is reached. */
  add(
    threadId: string,
    runId: string,
    extensionId: string,
    reply: (response: KaijuToolsResponse) => void,
  ): string | undefined {
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= this.#options.max || perThread >= this.#options.maxPerThread) {
      return undefined;
    }
    const requestId = `${this.#options.prefix}_${this.#next++}`;
    this.#pending.set(requestId, { threadId, runId, extensionId, reply });
    return requestId;
  }

  /** Whether the request still waits for its answer. */
  has(requestId: string): boolean {
    return this.#pending.has(requestId);
  }

  /** Remove the request to answer it; undefined when it was already answered (or never existed). */
  take(requestId: string): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return undefined;
    this.#pending.delete(requestId);
    return pending;
  }

  /** Answer one request with an error; false when it was already answered. */
  fail(requestId: string, code: string, message: string): boolean {
    const pending = this.take(requestId);
    if (pending === undefined) return false;
    pending.reply(toolsError(pending.extensionId, code, message));
    return true;
  }

  /** Connection lost: the server may have dropped the requests with it. */
  failAll(message: string): void {
    this.#failWhere(() => true, message);
  }

  failRun(runId: string, message: string): void {
    this.#failWhere((p) => p.runId === runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#failWhere((p) => p.threadId === threadId, message);
  }

  #failWhere(match: (pending: PendingRequest) => boolean, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (!match(pending)) continue;
      this.#pending.delete(id);
      pending.reply(toolsError(pending.extensionId, "unavailable", message));
    }
  }
}
