import type { KaijuToolsRequest, KaijuToolsResponse } from "@kaiju/protocol";
import type { FileShareFrame, FileShareResultFrame } from "@kaiju/protocol/sandbox-wire";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { toolsError } from "./channel.js";
import { PendingRequests } from "./pending-requests.js";
import { resolveSharePath, SharePathError } from "./share-path.js";

/**
 * The agent side of `share_file` (KOBE-149; contract: packages/protocol `files.ts`, push-then-share).
 * One `file.share` kobe-tools request becomes, in this order and only if each step succeeds:
 * confine the path (`share-path.ts`), push that one file through workspace sync, send the
 * `file.share` frame naming the pushed `{path, rev, sha256, size}`, and relay the server's
 * `file.share_result` as the tool result. Nothing is sent before the push succeeded; any failure
 * on the way (path, push, wire, run end, lost connection) is exactly one error answer.
 *
 * Wire `request_id`s are minted here, and the frame carries the run and thread the agent knows,
 * never ones the extension names (as `ArtifactBroker`). The server is idempotent on the tool call,
 * and this side never re-sends a frame.
 */
export const MAX_PENDING_SHARES = 16;
export const MAX_PENDING_SHARES_PER_THREAD = 4;

export interface FileShareBrokerDeps {
  /** The workspace root (`KAIJU_WORKSPACE_DIR`). */
  readonly root: string;
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: FileShareFrame) => boolean;
  readonly pushPath: (rel: string) => Promise<PushedFile>;
}

type ShareRequest = Extract<KaijuToolsRequest, { op: "file.share" }>;

export class FileShareBroker {
  readonly #deps: FileShareBrokerDeps;
  readonly #pending = new PendingRequests({
    prefix: "fs",
    max: MAX_PENDING_SHARES,
    maxPerThread: MAX_PENDING_SHARES_PER_THREAD,
  });

  constructor(deps: FileShareBrokerDeps) {
    this.#deps = deps;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  share(
    threadId: string,
    runId: string | undefined,
    request: ShareRequest,
    reply: (response: KaijuToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    // Registered before the (slow) push, so a run that ends meanwhile answers it exactly once.
    const requestId = this.#pending.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "too many file shares in flight"));
      return;
    }
    void this.#run(requestId, threadId, runId, request);
  }

  async #run(requestId: string, threadId: string, runId: string, request: ShareRequest) {
    // A no-op once answered (run ended, connection lost).
    const fail = (code: string, message: string) => this.#pending.fail(requestId, code, message);
    try {
      const { rel } = await resolveSharePath(this.#deps.root, request.input.path);
      const workspace = await this.#deps.pushPath(rel);
      if (!this.#pending.has(requestId)) return; // answered while pushing: send nothing
      const frame: FileShareFrame = {
        v: 1,
        type: "file.share",
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        tool_call_id: request.tool_call_id,
        tool: request.tool,
        input: request.input,
        workspace: {
          path: workspace.path,
          rev: workspace.rev,
          sha256: workspace.sha256,
          size: workspace.size,
        },
      };
      if (!this.#deps.send(frame)) fail("unavailable", "Kaiju server not reachable");
    } catch (error) {
      if (error instanceof SharePathError) fail(error.code, error.message);
      else if (error instanceof PushPathError) fail("not_synced", error.message);
      else fail("not_synced", "the file could not be pushed to the Kaiju server");
    }
  }

  /** `file.share_result` from the server; false when nothing waits for it (late, or unknown). */
  onResult(frame: FileShareResultFrame): boolean {
    const pending = this.#pending.take(frame.request_id);
    if (pending === undefined) return false;
    if (!frame.ok) {
      pending.reply({ id: pending.extensionId, ok: false, error: frame.error });
      return true;
    }
    const { v: _v, type: _type, request_id: _request, ...fields } = frame;
    pending.reply({ id: pending.extensionId, ...fields });
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
