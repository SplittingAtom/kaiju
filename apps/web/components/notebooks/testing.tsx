/**
 * Test doubles for the notebook views (KOBE-465): a workspace that saves and reads one file, a
 * kernel API that records calls, and run event streams the test feeds.
 */
import { render } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
import type {
  KaijuEvent,
  KaijuEventPayload,
  KaijuEventType,
  NotebookCompletionBody,
  NotebookHistoryEntry,
  NotebookOutput,
  NotebookRunBody,
} from "@kaiju/protocol";
import type { ApiResult } from "../../lib/api/client";
import type { EventSourceLike } from "../../lib/chat/stream";
import type { FilesApi } from "../../lib/files/api";
import { sha256Hex } from "../../lib/files/editor";
import { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import type {
  KernelCompletionAnswer,
  KernelStart,
  NotebookApi,
  NotebookRunStarted,
} from "../../lib/notebooks/api";
import { NotebookExecStore } from "../../lib/notebooks/executions";
import type { VariablesResult } from "../../lib/notebooks/variables";
import { TooltipProvider } from "../ui/tooltip";
import NotebookView from "./notebook-view";
import PythonFile from "./python-run";
import type { KernelWiring } from "./use-kernel";

export const TEAM = "00000000-0000-4000-8000-0000000000aa";
export const THREAD = "00000000-0000-4000-8000-0000000000bb";

const enc = (s: string) => new TextEncoder().encode(s);

export class StubSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  send(event: KaijuEvent) {
    for (const l of this.listeners.get(event.type) ?? []) {
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
}

let seq = 0;
export function ev<T extends KaijuEventType>(
  runId: string,
  type: T,
  payload: KaijuEventPayload<T>,
): KaijuEvent {
  seq += 1;
  return { run_id: runId, seq, ts: "2026-10-21T10:00:00Z", type, payload } as KaijuEvent;
}

/** One workspace file that saves at a version and reads back. */
export class Workspace {
  text: string;
  saves: { base: string; text: string }[] = [];
  constructor(
    readonly path: string,
    text: string,
  ) {
    this.text = text;
  }
  readonly api = {
    // A refused save names the version there now (file-editor's conflict choices).
    list: vi.fn(async () => ({
      ok: false as const,
      error: { status: 404, code: "not_found", message: "gone" },
    })),
    read: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { bytes: enc(this.text), truncated: false, size: null },
    })),
    save: vi.fn(async (_path: string, base: string, text: string) => {
      this.saves.push({ base, text });
      if (base !== (await sha256Hex(enc(this.text)))) {
        return {
          ok: false as const,
          error: { status: 409, code: "version_conflict", message: "changed" },
        };
      }
      this.text = text;
      return { ok: true as const, status: 200, data: { sha256: await sha256Hex(enc(text)) } };
    }),
  } as unknown as FilesApi;
}

export class Kernel {
  runs: NotebookRunBody[] = [];
  ops: string[] = [];
  next: ApiResult<NotebookRunStarted>[] = [];
  /** `start` answers in order (then idle); a pending promise holds one. */
  starts: (ApiResult<KernelStart> | Promise<ApiResult<KernelStart>>)[] = [];
  sources: StubSource[] = [];
  /** `variables` calls (`refresh` each) and their answers in order (then `no_kernel`). */
  variableCalls: (boolean | string)[] = [];
  variableAnswers: (ApiResult<VariablesResult> | Promise<ApiResult<VariablesResult>>)[] = [];
  /** `history` calls (path each) and what it answers; `outputs` per execution id. */
  historyCalls: string[] = [];
  history: NotebookHistoryEntry[] = [];
  outputCalls: string[] = [];
  pastOutputs = new Map<string, NotebookOutput[]>();
  /** How many `outputs` calls fail first. */
  outputFailures = 0;
  readonly store = new NotebookExecStore();
  /** Kernel completion requests (KOBE-808), and their answers in order (then `no_kernel`). */
  completions: NotebookCompletionBody[] = [];
  completeAnswers: ApiResult<KernelCompletionAnswer>[] = [];
  readonly api: NotebookApi = {
    complete: async (_thread, body) => {
      this.completions.push(body);
      return (
        this.completeAnswers.shift() ?? { ok: true, status: 200, data: { status: "no_kernel" } }
      );
    },
    run: async (_thread, body) => {
      this.runs.push(body);
      const n = this.runs.length;
      return (
        this.next.shift() ?? {
          ok: true,
          status: 202,
          data: { runId: runId(n), execId: execId(n) },
        }
      );
    },
    start: async () => {
      this.ops.push("start");
      return this.starts.shift() ?? { ok: true, status: 200, data: { status: "idle" } };
    },
    kernel: async (_thread, op) => {
      this.ops.push(op);
      return {
        ok: true,
        status: 200,
        data: { status: op === "restart" ? "restarted" : "interrupted" },
      };
    },
    history: async (_thread, path) => {
      this.historyCalls.push(path);
      return { ok: true, status: 200, data: this.history };
    },
    outputs: async (_thread, exec) => {
      this.outputCalls.push(exec);
      if (this.outputFailures > 0) {
        this.outputFailures -= 1;
        return { ok: false, error: { status: 503, code: "unavailable", message: "down" } };
      }
      return { ok: true, status: 200, data: this.pastOutputs.get(exec) ?? [] };
    },
    variables: async (_thread, refresh, show) => {
      this.variableCalls.push(show === undefined ? refresh : `show:${show}`);
      return (
        this.variableAnswers.shift() ?? { ok: true, status: 200, data: { status: "no_kernel" } }
      );
    },
  };
  wiring(threadId: string | null = THREAD, readOnly = false): KernelWiring {
    return {
      threadId,
      readOnly,
      api: this.api,
      runs: this.store,
      teamId: TEAM,
      eventSource: (url) => {
        const s = new StubSource(url);
        this.sources.push(s);
        return s;
      },
    };
  }
}

export const runId = (n: number) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
export const execId = (n: number) => `00000000-0000-4000-9000-${String(100 + n).padStart(12, "0")}`;

/** The notebook as the file tab shows it: `onSaved` shows the saved text without a read. */
export function Harness({
  workspace,
  kernel,
  sha,
  drafts = new EditDraftStore(),
  reviews = new FileReviewStore(),
  onReload = () => {},
}: {
  readonly workspace: Workspace;
  readonly kernel: KernelWiring | undefined;
  readonly sha: string;
  readonly drafts?: EditDraftStore;
  readonly reviews?: FileReviewStore;
  readonly onReload?: () => void;
}) {
  const [file, setFile] = useState({ text: workspace.text, sha });
  return (
    <NotebookView
      path={workspace.path}
      text={file.text}
      sha256={file.sha}
      truncated={false}
      files={workspace.api}
      drafts={drafts}
      reviews={reviews}
      kernel={kernel}
      onSaved={(text, sha256) => setFile({ text, sha: sha256 })}
      onReload={onReload}
    />
  );
}

export function notebookJson(cells: readonly Record<string, unknown>[], minor = 5): string {
  return `${JSON.stringify({ nbformat: 4, nbformat_minor: minor, metadata: {}, cells }, null, 1)}\n`;
}

/** A `.py` file as the file tab shows it (KOBE-804/805): `onSaved` shows the saved text. */
export function PythonHarness({
  workspace,
  kernel,
  sha,
  drafts,
}: {
  readonly workspace: Workspace;
  readonly kernel: KernelWiring | undefined;
  readonly sha: string;
  readonly drafts: EditDraftStore;
}) {
  const [file, setFile] = useState({ text: workspace.text, sha });
  return (
    <TooltipProvider>
      <PythonFile
        path={workspace.path}
        text={file.text}
        sha256={file.sha}
        truncated={false}
        api={workspace.api}
        drafts={drafts}
        reviews={new FileReviewStore()}
        kernel={kernel}
        onSaved={(text, sha256) => setFile({ text, sha: sha256 })}
        onReload={() => {}}
      />
    </TooltipProvider>
  );
}

/** Renders `path` with `text` as a `.py` file in a conversation's kernel. */
export async function renderPython({
  path = "src/job.py",
  text = "print(1)\n",
  drafts = new EditDraftStore(),
  threadId = THREAD,
  readOnly = false,
  kernel = new Kernel(),
}: {
  readonly kernel?: Kernel;
  readonly path?: string;
  readonly text?: string;
  readonly drafts?: EditDraftStore;
  readonly threadId?: string | null;
  readonly readOnly?: boolean;
} = {}) {
  const workspace = new Workspace(path, text);
  const sha = await sha256Hex(enc(text));
  render(
    <PythonHarness
      workspace={workspace}
      kernel={kernel.wiring(threadId, readOnly)}
      sha={sha}
      drafts={drafts}
    />,
  );
  return { kernel, workspace, drafts };
}
