/**
 * The thread's notebook kernel over the shared client (KOBE-464 routes; KOBE-465 web): run a cell
 * or a `.py` file (202 {run_id, exec_id}; follow the run's events), start (KOBE-477), interrupt or
 * restart. The
 * thread's owner only; the server decides everything.
 */
import {
  type NotebookCompletionBody,
  notebookExecOutputsResponseSchema,
  notebookHistoryResponseSchema,
  type NotebookHistoryEntry,
  type NotebookKernelResponse,
  type NotebookOutput,
  type NotebookRunBody,
} from "@kaiju/protocol";
import type { z } from "zod";
import { apiRequest, apiTextFile, type ApiError, type ApiResult } from "../api/client";
import type { VariablesResult } from "./variables";

export interface NotebookRunStarted {
  readonly runId: string;
  readonly execId: string;
}

/** `POST .../notebook/start` (KOBE-477): waking (ask again after `retryAfterMs`), or the kernel. */
export type KernelStart =
  | { readonly status: "waking"; readonly retryAfterMs: number }
  | { readonly status: "idle" | "busy" };

/**
 * `POST .../notebook/complete` (KOBE-808), camelized: the kernel's completions (`op: "complete"`;
 * the span is in code points of the code sent) or a name's documentation (`op: "doc"`), or why
 * there is none. Matches and docs are untrusted text.
 */
export type KernelCompletionAnswer =
  | {
      readonly status: "ok";
      readonly op: "complete";
      readonly matches: readonly { readonly text: string; readonly type?: string }[];
      readonly cursorStart: number;
      readonly cursorEnd: number;
    }
  | {
      readonly status: "ok";
      readonly op: "doc";
      readonly found: boolean;
      readonly signature?: string;
      readonly doc?: string;
      readonly type?: string;
    }
  | { readonly status: "busy" | "no_kernel" | "unavailable" | "asleep" | "unsupported" };

export interface NotebookApi {
  run(threadId: string, body: NotebookRunBody): Promise<ApiResult<NotebookRunStarted>>;
  start(threadId: string): Promise<ApiResult<KernelStart>>;
  kernel(threadId: string, op: "interrupt" | "restart"): Promise<ApiResult<NotebookKernelResponse>>;
  complete(
    threadId: string,
    body: NotebookCompletionBody,
    signal?: AbortSignal,
  ): Promise<ApiResult<KernelCompletionAnswer>>;
  /**
   * `POST .../notebook/variables` (KOBE-803): the kernel's variables, live from the sandbox and
   * never stored; `refresh` asks for a fresh snapshot instead of the one kept after the last run.
   */
  variables(threadId: string, refresh: boolean, show?: string): Promise<ApiResult<VariablesResult>>;
  /**
   * `GET .../notebook/executions?path=` (KOBE-804): the `.py` file's last 50 runs from the
   * stored run events, newest first, without outputs. Kept in the server's wire casing (the
   * store reads protocol payloads).
   */
  history(threadId: string, path: string): Promise<ApiResult<readonly NotebookHistoryEntry[]>>;
  /** `GET .../notebook/executions/{exec_id}/outputs` (KOBE-804): one past run's outputs. */
  outputs(threadId: string, execId: string): Promise<ApiResult<readonly NotebookOutput[]>>;
}

const enc = encodeURIComponent;

/** What the server sent is not what the contract says. */
const MALFORMED: ApiError = {
  status: 502,
  code: "malformed_response",
  message: "The server sent an answer Kaiju could not read.",
};

export function createNotebookApi(teamId: string, fetchFn?: typeof fetch): NotebookApi {
  const opts = { teamId, fetchFn, method: "POST" as const };
  /**
   * A GET whose body keeps the server's casing (protocol payloads and notebook outputs, which
   * `apiRequest` would camelize), checked against its schema.
   */
  async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<ApiResult<T>> {
    const res = await apiTextFile(path, { teamId, fetchFn });
    if (!res.ok) return res;
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.data.text);
    } catch {
      return { ok: false, error: MALFORMED };
    }
    const checked = schema.safeParse(parsed);
    return checked.success
      ? { ok: true, status: res.status, data: checked.data }
      : { ok: false, error: MALFORMED };
  }
  return {
    run: (threadId, body) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/run`, { ...opts, json: body }),
    start: (threadId) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/start`, { ...opts, json: {} }),
    kernel: (threadId, op) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/${op}`, { ...opts, json: {} }),
    complete: (threadId, body, signal) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/complete`, { ...opts, json: body, signal }),
    variables: (threadId, refresh, show) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/variables`, {
        ...opts,
        // KOBE-816: Show asks for that one variable, its value not withheld by the sandbox.
        json: show !== undefined ? { show } : refresh ? { refresh: true } : {},
      }),
    history: async (threadId, path) => {
      const q = new URLSearchParams({ path }).toString();
      const res = await readJson(
        `/v1/threads/${enc(threadId)}/notebook/executions?${q}`,
        notebookHistoryResponseSchema,
      );
      return res.ok ? { ...res, data: res.data.executions } : res;
    },
    outputs: async (threadId, execId) => {
      const res = await readJson(
        `/v1/threads/${enc(threadId)}/notebook/executions/${enc(execId)}/outputs`,
        notebookExecOutputsResponseSchema,
      );
      return res.ok ? { ...res, data: res.data.outputs } : res;
    },
  };
}

/**
 * The document an HTML output's iframe loads: the server's fixed shell with the artifact frame's
 * headers, to which the page posts the HTML (never `srcdoc`).
 */
export function outputFrameUrl(teamId: string): string {
  return `/v1/workspace/output-frame?${new URLSearchParams({ team: teamId }).toString()}`;
}

/** The message the shell accepts (the server's `NOTEBOOK_OUTPUT_FRAME_MESSAGE`). */
export const OUTPUT_FRAME_MESSAGE = "kobe.notebook.html";
