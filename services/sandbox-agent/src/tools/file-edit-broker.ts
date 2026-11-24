import type { KaijuToolsRequest, KaijuToolsResponse } from "@kaiju/protocol";
import type {
  FileEditProposeFrame,
  FileEditProposeResultFrame,
} from "@kaiju/protocol/sandbox-wire";
import { toolsError } from "./channel.js";
import { PendingRequests } from "./pending-requests.js";

/**
 * Routes `propose_file_edit` kaiju-tools requests to the server and its answers back (KOBE-462,
 * file-edit-frames.ts `file.edit_propose`, `file.edit_propose_result`). Nothing is pushed first:
 * the proposal is the call's input and its base is the server's synced copy. Same rules as
 * {@link ArtifactBroker}: wire ids are minted here, the frame carries the run and thread the agent
 * knows, every pending request is answered exactly once, and anything that prevents an answer is
 * an error (fail closed).
 */
export const MAX_PENDING_PROPOSALS = 32;
export const MAX_PENDING_PROPOSALS_PER_THREAD = 4;

type ProposeRequest = Extract<KaijuToolsRequest, { op: "file.edit_propose" }>;

export interface FileEditBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: FileEditProposeFrame) => boolean;
}

export class FileEditBroker {
  readonly #deps: FileEditBrokerDeps;
  readonly #pending = new PendingRequests({
    prefix: "fe",
    max: MAX_PENDING_PROPOSALS,
    maxPerThread: MAX_PENDING_PROPOSALS_PER_THREAD,
  });

  constructor(deps: FileEditBrokerDeps) {
    this.#deps = deps;
  }

  propose(
    threadId: string,
    runId: string | undefined,
    request: ProposeRequest,
    reply: (response: KaijuToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const requestId = this.#pending.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "too many proposals in flight"));
      return;
    }
    const frame: FileEditProposeFrame = {
      v: 1,
      type: "file.edit_propose",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
      tool: request.tool,
      input: request.input,
    };
    if (!this.#deps.send(frame)) {
      this.#pending.fail(requestId, "unavailable", "Kaiju server not reachable");
    }
  }

  /** `file.edit_propose_result` from the server; false when nothing waits for it. */
  onResult(frame: FileEditProposeResultFrame): boolean {
    const pending = this.#pending.take(frame.request_id);
    if (pending === undefined) return false;
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body });
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
