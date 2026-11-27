import type { KaijuToolsRequest, KaijuToolsResponse } from "@kaiju/protocol";
import type {
  EditorReadFrame,
  EditorReadResultFrame,
  NotebookRunFrame,
  NotebookRunResultFrame,
} from "@kaiju/protocol/sandbox-wire";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { toolsError } from "./channel.js";
import { PendingRequests } from "./pending-requests.js";
import { resolveSharePath, SharePathError } from "./share-path.js";

/**
 * The agent side of `run_python` (KOBE-464; docs/specs/notebooks.md NB13). A `code` call goes to
 * the server as is; a `path` call first confines the path and pushes that file through workspace
 * sync (the server runs the synced copy, as `share_file` shares it). The server answers once the
 * execution ended (it sends the `notebook.execute` back to this sandbox meanwhile). Same rules as
 * the other brokers: wire ids are minted here, the frame carries the run and thread the agent
 * knows, every pending request is answered exactly once, and any failure is an error answer.
 * KOBE-848: `editor_run` takes the same path as `run_python {path}` (the frame's `tool` says
 * which); `editor_read` sends `editor.read` as is (nothing to push: the server reads what it has).
 */
export const MAX_PENDING_RUNS = 16;
export const MAX_PENDING_RUNS_PER_THREAD = 2;

type RunRequest = Extract<KaijuToolsRequest, { op: "notebook.run" }>;
type ReadRequest = Extract<KaijuToolsRequest, { op: "editor.read" }>;

export interface NotebookBrokerDeps {
  readonly root: string;
  readonly send: (frame: NotebookRunFrame | EditorReadFrame) => boolean;
  /** Absent without workspace sync: `path` calls are refused. */
  readonly pushPath?: ((rel: string) => Promise<PushedFile>) | undefined;
}

export class NotebookBroker {
  readonly #deps: NotebookBrokerDeps;
  readonly #pending = new PendingRequests({
    prefix: "nb",
    max: MAX_PENDING_RUNS,
    maxPerThread: MAX_PENDING_RUNS_PER_THREAD,
  });

  readonly #reads = new PendingRequests({
    prefix: "er",
    max: MAX_PENDING_RUNS,
    maxPerThread: MAX_PENDING_RUNS_PER_THREAD,
  });

  constructor(deps: NotebookBrokerDeps) {
    this.#deps = deps;
  }

  run(
    threadId: string,
    runId: string | undefined,
    request: RunRequest,
    reply: (response: KaijuToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const requestId = this.#pending.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "too many executions in flight"));
      return;
    }
    void this.#send(requestId, threadId, runId, request);
  }

  async #send(requestId: string, threadId: string, runId: string, request: RunRequest) {
    // A no-op once answered (run ended, connection lost).
    const fail = (code: string, message: string) => this.#pending.fail(requestId, code, message);
    try {
      const path = request.input.path;
      if (path !== undefined) {
        if (this.#deps.pushPath === undefined) {
          fail("not_synced", "running a file needs workspace sync, which this sandbox lacks");
          return;
        }
        const { rel } = await resolveSharePath(this.#deps.root, path);
        await this.#deps.pushPath(rel);
        if (!this.#pending.has(requestId)) return; // answered while pushing: send nothing
      }
      const ids = {
        v: 1,
        type: "notebook.run",
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        tool_call_id: request.tool_call_id,
      } as const;
      const frame: NotebookRunFrame =
        request.tool === "editor_run"
          ? { ...ids, tool: request.tool, input: request.input }
          : { ...ids, tool: request.tool, input: request.input };
      if (!this.#deps.send(frame)) fail("unavailable", "Kaiju server not reachable");
    } catch (error) {
      if (error instanceof SharePathError) fail(error.code, error.message);
      else if (error instanceof PushPathError) fail("not_synced", error.message);
      else fail("not_synced", "the file could not be pushed to the Kaiju server");
    }
  }

  /** `editor_read` (KOBE-848): sent at once; answered by `editor.read_result`. */
  read(
    threadId: string,
    runId: string | undefined,
    request: ReadRequest,
    reply: (response: KaijuToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const requestId = this.#reads.add(threadId, runId, request.id, reply);
    if (requestId === undefined) {
      reply(toolsError(request.id, "unavailable", "too many reads in flight"));
      return;
    }
    const frame: EditorReadFrame = {
      v: 1,
      type: "editor.read",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
      tool: request.tool,
      input: request.input,
    };
    if (!this.#deps.send(frame))
      this.#reads.fail(requestId, "unavailable", "Kaiju server not reachable");
  }

  /** `editor.read_result` from the server; false when nothing waits for it. */
  onReadResult(frame: EditorReadResultFrame): boolean {
    const pending = this.#reads.take(frame.request_id);
    if (pending === undefined) return false;
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body });
    return true;
  }

  /** `notebook.run_result` from the server; false when nothing waits for it. */
  onResult(frame: NotebookRunResultFrame): boolean {
    const pending = this.#pending.take(frame.request_id);
    if (pending === undefined) return false;
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body });
    return true;
  }

  failAll(message: string): void {
    this.#pending.failAll(message);
    this.#reads.failAll(message);
  }

  failRun(runId: string, message: string): void {
    this.#pending.failRun(runId, message);
    this.#reads.failRun(runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#pending.failThread(threadId, message);
    this.#reads.failThread(threadId, message);
  }
}
