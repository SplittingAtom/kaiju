/**
 * A fake Kaiju server for chat tests: the Thread API, the run orchestrator and the Kaiju Event Stream
 * with the real wire shapes (snake_case JSON over `fetch`, SSE resume by `starting_after` /
 * `Last-Event-ID`, 204 after the end, 410 when compacted). It follows the server's rules where the
 * UI depends on them (D14 interrupted blocks the queue, D17 queue/Stop, KOBE-34 leaf/Trash busy
 * rules) so the chat is tested over its real API client, casing layer and stream code.
 * `agent` scripts what Pi would do in a run.
 *
 * KOBE-717: the server's records are in `fake/store.ts`, its shared rules in `fake/core.ts` and the
 * routes in one handler per API area (`fake/<area>.ts`), asked in the order of the tables below;
 * this class keeps the test setup, the scripted agent, `fetch` and the event streams.
 */
import type { KaijuEvent, KaijuEventPayload } from "@kaiju/protocol";
import type { EventSourceFactory, EventSourceLike } from "../stream";
import { accountArea, teamAccountArea } from "./fake/account";
import { approvalsArea } from "./fake/approvals";
import { artifactsArea } from "./fake/artifacts";
import { FakeCore } from "./fake/core";
import { egressArea } from "./fake/egress";
import { memoryArea } from "./fake/memory";
import { projectsArea } from "./fake/projects";
import { runsArea } from "./fake/runs";
import {
  error,
  NOW,
  uuid,
  type FakeAnswer,
  type FakeRequest,
  type FakeRun,
  type Json,
} from "./fake/state";
import { threadsArea } from "./fake/threads";
import { workspaceArea } from "./fake/workspace";

export {
  FAKE_FRAME_CSP,
  type FakeArtifact,
  type FakeRunnableAgent,
  type FakeTeamModel,
  type RecordedRequest,
} from "./fake/state";

type FakeArea = (k: FakeCore, req: FakeRequest) => FakeAnswer;

/** Areas outside a team's scope, asked in this order (each answers only its own paths). */
const OPEN_AREAS: readonly FakeArea[] = [accountArea, artifactsArea, workspaceArea, memoryArea];
/** Team-scoped areas: asked once `X-Kobe-Team` names the fake's team. */
const TEAM_AREAS: readonly FakeArea[] = [
  teamAccountArea,
  threadsArea,
  projectsArea,
  runsArea,
  approvalsArea,
  egressArea,
];

function teamScoped(path: string): boolean {
  return (
    path === "/v1/team/budgets/status" ||
    path.startsWith("/v1/threads") ||
    path.startsWith("/v1/thread-folders") ||
    path.startsWith("/v1/runs") ||
    path.startsWith("/v1/eval-cases") ||
    path.startsWith("/v1/approvals") ||
    path === "/v1/team/retention" ||
    path === "/v1/projects" ||
    path.startsWith("/v1/projects/") ||
    path === "/v1/me/checkouts" ||
    path === "/v1/skills/drafts/saves" ||
    path.startsWith("/v1/egress/requests")
  );
}

export class FakeKaiju extends FakeCore {
  // --- setup ----------------------------------------------------------------------------------

  /** An artifact that exists before the test; `versions` are the contents of v1, v2, ... */
  addArtifact(
    threadId: string,
    a: {
      readonly kind: string;
      readonly title: string;
      readonly versions: readonly string[];
      readonly language?: string;
    },
  ): string {
    this.counters.artifact += 1;
    const id = uuid(7, this.counters.artifact);
    this.artifacts.set(id, {
      id,
      thread_id: threadId,
      kind: a.kind,
      title: a.title,
      language: a.language ?? null,
      versions: [...a.versions],
    });
    return id;
  }

  /** A file `share_file` made; the download answers `status` (200 serves `bytes`). */
  addSharedFile(bytes: Uint8Array, status = 200): string {
    const id = uuid(8, this.sharedFiles.size + 1);
    this.sharedFiles.set(id, { bytes, status });
    return id;
  }

  /** Marks a thread as started by a schedule (KOBE-175). */
  setScheduleId(threadId: string, scheduleId: string): void {
    this.thread(threadId).schedule_id = scheduleId;
  }

  /**
   * The server-written skipped-actions summary of a scheduled run (KOBE-178): a `custom_message`
   * under `parentId` that never moves the leaf.
   */
  addSkippedSummary(threadId: string, parentId: string, content: string, count: number): string {
    const thread = this.thread(threadId);
    const id = `ks-${thread.entries.length + 1}`;
    thread.entries.push({
      entry_id: id,
      parent_id: parentId,
      seq: thread.entries.length + 1,
      type: "custom_message",
      payload: {
        type: "custom_message",
        id,
        parentId,
        timestamp: NOW,
        customType: "kobe.skipped_actions",
        content,
        display: true,
        details: { run_id: "r-scheduled", skipped_count: count },
      },
      payload_offloaded: false,
      created_at: NOW,
    });
    return id;
  }

  /** A Retry waiting in the queue (the server's abort hold): it runs before every message. */
  queueRetry(threadId: string, input: string): string {
    this.counters.run += 1;
    const run: FakeRun = {
      run_id: uuid(4, this.counters.run),
      thread_id: threadId,
      status: "queued",
      input,
      parent_entry_id: null,
      queue_pos: 0,
      retry_of_run_id: uuid(4, 9_000 + this.counters.run),
      events: [],
      compacted: false,
      tip: null,
    };
    this.runs.set(run.run_id, run);
    return run.run_id;
  }

  /** A run that answered `userEntryId` long ago (KOBE-275: a rateable answer of a seeded thread). */
  addEndedRun(threadId: string, userEntryId: string, status = "completed"): string {
    this.counters.run += 1;
    const run: FakeRun = {
      run_id: uuid(4, this.counters.run),
      thread_id: threadId,
      status,
      input: "",
      parent_entry_id: null,
      queue_pos: 0,
      events: [],
      compacted: true,
      tip: null,
      user_entry_id: userEntryId,
    };
    this.runs.set(run.run_id, run);
    return run.run_id;
  }

  // --- the agent (what Pi does inside a run) -----------------------------------------------------

  /** The server asks the run's user (KOBE-37): records the approval and emits the card event. */
  requestApproval(runId: string, payload: KaijuEventPayload<"approval.requested">): void {
    this.approvals.set(payload.approval_id, { runId, payload, status: "pending" });
    this.run(runId).status = "waiting_approval";
    this.emit(runId, "approval.requested", payload);
  }

  readonly agent = {
    delta: (runId: string, messageId: string, delta: string, contentIndex = 0) =>
      this.emit(runId, "text.delta", { message_id: messageId, content_index: contentIndex, delta }),
    toolCall: (runId: string, toolCallId: string, tool: string, input: Json, messageId?: string) =>
      this.emit(runId, "tool.call", {
        tool_call_id: toolCallId,
        tool,
        input: input as never,
        risk: "write",
        ...(messageId ? { message_id: messageId } : {}),
      }),
    toolResult: (
      runId: string,
      toolCallId: string,
      tool: string,
      preview: string,
      isError = false,
    ) =>
      this.emit(runId, "tool.result", {
        tool_call_id: toolCallId,
        tool,
        is_error: isError,
        preview,
        truncated: false,
      }),
    commit: (runId: string, message: Json, messageId?: string) =>
      this.commitEntry(
        runId,
        (threadId, parentId) => this.addEntry(threadId, parentId, message, { leaf: false }),
        messageId,
      ),
    /**
     * The sandbox agent's branch marker (`kobe.branch` custom entry) under the run's branch point,
     * appended before Pi starts when `run.start` carries `parent_entry_id`; the prompt hangs below it.
     */
    branchMarker: (runId: string) =>
      this.commitEntry(runId, (threadId, parentId) =>
        this.addSystemEntry(
          threadId,
          parentId,
          "custom",
          { customType: "kobe.branch", data: { run_id: runId } },
          { leaf: false },
        ),
      ),
    /**
     * Pi's `model_change` entry: Pi starts on the run's model and, when the branch was on another
     * one, records the switch before the prompt (Pi 1.0; KOBE-209 markers, KOBE-217).
     */
    modelChange: (runId: string, modelId: string) =>
      this.commitEntry(runId, (threadId, parentId) =>
        this.addSystemEntry(
          threadId,
          parentId,
          "model_change",
          { provider: "kobe", modelId },
          { leaf: false },
        ),
      ),
    commitPrompt: (runId: string) => {
      const entryId = this.agent.commit(runId, { role: "user", content: this.run(runId).input });
      this.run(runId).user_entry_id = entryId;
      return entryId;
    },
    /** `epilogue`: the server will title the thread / suggest follow-ups after the run. */
    complete: (
      runId: string,
      options: { readonly epilogue?: readonly ("title" | "followups")[] } = {},
    ) => {
      const run = this.run(runId);
      // Like the server: the leaf moves in the same transaction as the terminal event.
      this.thread(run.thread_id).leaf_entry_id =
        run.tip ?? this.thread(run.thread_id).leaf_entry_id;
      this.end(run, "completed", "run.completed", {
        leaf_entry_id: run.tip,
        ...(options.epilogue ? { epilogue: [...options.epilogue] } : {}),
      });
      this.advance(run.thread_id);
    },
    /** The server's title call answered (KOBE-219): saved first, then `thread.updated`. */
    retitle: (runId: string, title: string) => {
      const run = this.run(runId);
      this.thread(run.thread_id).title = title;
      this.emit(runId, "thread.updated", { thread_id: run.thread_id, title });
    },
    /** The leaf moved (CT13: the route in another tab, a commit): `thread.updated` on the run. */
    leafMoved: (runId: string, leafEntryId: string) => {
      const run = this.run(runId);
      this.thread(run.thread_id).leaf_entry_id = leafEntryId;
      this.emit(runId, "thread.updated", { thread_id: run.thread_id, leaf_entry_id: leafEntryId });
    },
    /** The server's follow-up call answered (KOBE-222): `thread.suggestions` on the run. */
    suggest: (runId: string, suggestions: readonly string[]) => {
      const run = this.run(runId);
      this.emit(runId, "thread.suggestions", {
        thread_id: run.thread_id,
        suggestions: [...suggestions],
      });
    },
    fail: (runId: string, code: string, message: string) => {
      this.end(this.run(runId), "failed", "run.failed", { error: { code, message } });
      this.advance(this.run(runId).thread_id);
    },
    /** A budget ran out mid-run (KOBE-42): the run stops, the queue advances. */
    budgetStop: (runId: string) => {
      this.end(this.run(runId), "budget_stopped", "run.budget_stopped", {
        scope: "user",
        message: "The run stopped because your budget is used up.",
      });
      this.advance(this.run(runId).thread_id);
    },
    /** The sandbox died mid-run (D14): interrupted, Retry offered, the queue waits. */
    loseSandbox: (runId: string) => {
      const run = this.run(runId);
      this.end(run, "interrupted", "run.interrupted", {
        reason: "sandbox_lost",
        last_entry_id: run.tip,
        retryable: true,
      });
    },
  };

  // --- HTTP -----------------------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://kaiju.test");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    this.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      team: headers.get("x-kobe-team"),
      idempotencyKey: headers.get("idempotency-key"),
      body,
    });
    const key = `${method} ${url.pathname}`;
    if (method === "POST" && url.pathname.endsWith("/compact")) await this.compactGate;
    const forced = this.failNext.get(key);
    if (forced) {
      this.failNext.delete(key);
      return forced;
    }
    const req: FakeRequest = {
      method,
      url,
      body: body as Json | undefined,
      raw: init.body,
      headers,
    };
    for (const area of OPEN_AREAS) {
      const answer = area(this, req);
      if (answer !== undefined) return answer;
    }
    if (!teamScoped(url.pathname)) return error(404, "not_found");
    if (headers.get("x-kobe-team") !== this.teamId) return error(409, "team_mismatch");
    for (const area of TEAM_AREAS) {
      const answer = area(this, req);
      if (answer !== undefined) return answer;
    }
    return error(404, "not_found");
  };

  // --- SSE ------------------------------------------------------------------------------------

  /** Open event streams (tests check what the browser is connected to). */
  get openStreams(): readonly FakeEventSource[] {
    return [...this.sources].filter((s) => s.readyState !== 2);
  }

  readonly eventSource: EventSourceFactory = (url) => {
    const parsed = new URL(url, "http://kaiju.test");
    // Not in `requests`: tests count run streams there; `workspaceChanges.open` lists these.
    if (parsed.pathname === "/v1/workspace/changes") return this.workspaceChanges.connect(parsed);
    if (parsed.pathname === "/v1/workspace/events") return this.workspaceEvents.connect();
    const runId = parsed.pathname.split("/")[3] ?? "";
    const after = Number(parsed.searchParams.get("starting_after") ?? "0");
    const source = new FakeEventSource(this, runId, after, () => this.sources.delete(source));
    this.sources.add(source);
    this.requests.push({
      method: "SSE",
      path: `${parsed.pathname}${parsed.search}`,
      team: null,
      idempotencyKey: null,
      body: undefined,
    });
    queueMicrotask(() => source.connect());
    return source;
  };

  /** Drops every open stream's connection; the browser reconnects with Last-Event-ID. */
  dropConnections(): void {
    for (const source of this.sources) source.drop();
  }
}

/**
 * EventSource as the browser and KOBE-31's server behave together: replay `seq > cursor`, then
 * live events; after a terminal event the server ends the response; a reconnect sends
 * `Last-Event-ID` and gets 204 (ended, nothing new) or 410 (compacted), which close the source.
 */
export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly #server: FakeKaiju;
  readonly runId: string;
  readonly startingAfter: number;
  #lastEventId = 0;
  readonly #onClose: () => void;
  /** Connections made (1 + reconnects). */
  connections = 0;

  constructor(server: FakeKaiju, runId: string, startingAfter: number, onClose: () => void) {
    this.#server = server;
    this.runId = runId;
    this.startingAfter = startingAfter;
    this.#onClose = onClose;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
    this.#onClose();
  }

  #cursor(): number {
    return Math.max(this.startingAfter, this.#lastEventId);
  }

  connect(): void {
    if (this.readyState === 2) return;
    this.connections += 1;
    const run = this.#server.runs.get(this.runId);
    const last = run?.events.length ?? 0;
    const refused =
      run === undefined || run.compacted || (this.#server.isEnded(run) && this.#cursor() >= last);
    if (refused) {
      // 404, 410 or 204: EventSource fails the connection for good.
      this.readyState = 2;
      this.#onClose();
      this.onerror?.(new Event("error"));
      return;
    }
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    this.deliver(run);
  }

  /** Sends every event after the cursor (the server re-reads Postgres on each hint). */
  deliver(run: { run_id: string; events: readonly KaijuEvent[] }): void {
    if (this.readyState !== 1 || run.run_id !== this.runId) return;
    for (const event of run.events) {
      if (event.seq <= this.#cursor() || this.readyState !== 1) continue;
      this.#lastEventId = event.seq;
      const message = new MessageEvent<string>(event.type, {
        data: JSON.stringify(event),
        lastEventId: String(event.seq),
      });
      for (const listener of this.#listeners.get(event.type) ?? []) listener(message);
      const epilogue = event.type === "run.completed" && (event.payload.epilogue?.length ?? 0) > 0;
      if (
        event.type.startsWith("run.") &&
        event.type !== "run.queued" &&
        event.type !== "run.started" &&
        !epilogue // KOBE-234: the response stays open for the announced results
      ) {
        this.drop(); // the server ends the response after a terminal event
        return;
      }
    }
  }

  /** The connection drops; the browser reconnects (Last-Event-ID) on the next tick. */
  drop(): void {
    if (this.readyState !== 1) return;
    this.readyState = 0;
    this.onerror?.(new Event("error"));
    setTimeout(() => this.connect(), 0);
  }

  /** A reconnect that replays from an older cursor (duplicates the client must drop). */
  rewind(to: number): void {
    this.#lastEventId = to;
  }
}
