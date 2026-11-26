/**
 * One open thread: loads it from Postgres through the API (never wakes a sandbox, D14), streams
 * the run that holds it (or the next queued one) and turns user actions into API calls (D17:
 * queue, Steer, Stop; D14: Retry / Continue without retry; branch switch and edit-and-regenerate).
 * The server decides everything; this only shows what it says and asks again after each change.
 */
import type { ItemReference, KaijuEvent, ThinkingLevel } from "@kaiju/protocol";
import type { ApiError, ApiResult } from "../api/client";
import type {
  AppContextWire,
  BranchSummaryResult,
  ChatApi,
  CompactResult,
  ForkOptions,
} from "./api";
import { newIdempotencyKey } from "./keys";
import { browserResumeStore, clearResumePoint, saveResumePoint, type ResumeStore } from "./resume";
import { settleHead } from "./head";
import { applyRunEvents } from "./live";
import {
  openRunStream,
  type EventSourceFactory,
  type RunStream,
  type StreamSignal,
} from "./stream";
import {
  initialThreadState,
  mergeCommittedEntries,
  mergeServerEntries,
  runToStream,
  settleStop,
  type ThreadState,
} from "./thread-state";
import type { MessageFiles } from "./attachments";
import type { EvalCaseOptions } from "./eval-cases";
import type { FeedbackChange } from "./feedback";
import type { ViewingChoice } from "./viewing";
import type { ThreadSummary, ThreadVisibility } from "./types";
import {
  followupsShown,
  planAfterClose,
  planSignal,
  planTerminal,
} from "./thread-controller/after-close";
import * as branches from "./thread-controller/branches";
import {
  historyOf,
  liveFileRequest,
  maxSeq,
  mayBeUnsavedPrompt,
  readThread,
  withPending,
  withRuns,
  withStreamedRun,
} from "./thread-controller/history";
import * as queue from "./thread-controller/queue";
import {
  CLIENT_ERROR,
  sendMessage,
  steerRun,
  type SendArgs,
  type SendPort,
} from "./thread-controller/send";
import * as settings from "./thread-controller/settings";

export { ON_LEAF_BRANCH } from "./thread-controller/branches";

export interface ControllerOptions {
  readonly api: ChatApi;
  readonly eventSource?: EventSourceFactory | undefined;
  /** Idempotency keys for sends (tests pass a counter). */
  readonly newKey?: () => string;
  /** Delay before reopening a stream the server closed while its run was still active. */
  readonly reopenDelayMs?: (attempt: number) => number;
  /** Per-tab resume points (`resume.ts`); default sessionStorage, `null` to always replay. */
  readonly resumeStore?: ResumeStore | null | undefined;
  /** The server titled the thread after a run (KOBE-219 `thread.updated`): the rail reads it. */
  readonly onRetitled?: ((threadId: string, title: string) => void) | undefined;
  /**
   * The member moved the leaf here (`POST /leaf`: Make it current, the owner's picker). No stream
   * carries it to other tabs (CT13 rides run streams), so the session tells this browser's tabs.
   */
  readonly onLeafMoved?: ((threadId: string) => void) | undefined;
  /** Every streamed batch of the thread's runs (KOBE-465: the notebook panel's executions). */
  readonly onRunEvents?: ((threadId: string, events: readonly KaijuEvent[]) => void) | undefined;
}

type Listener = () => void;

export class ThreadController {
  #state: ThreadState;
  readonly #listeners = new Set<Listener>();
  readonly #api: ChatApi;
  readonly #eventSource: EventSourceFactory | undefined;
  readonly #newKey: () => string;
  readonly #reopenDelay: (attempt: number) => number;
  readonly #resume: ResumeStore | undefined;
  #stream: RunStream | undefined;
  /** A completed run's stream kept open for its announced epilogue (KOBE-234/219). */
  #epilogue: RunStream | undefined;
  readonly #onRetitled: ((threadId: string, title: string) => void) | undefined;
  readonly #onRunEvents: ((threadId: string, events: readonly KaijuEvent[]) => void) | undefined;
  readonly #onLeafMoved: ((threadId: string) => void) | undefined;
  #reopenAttempts = 0;
  #reopenTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshAgain = false;
  #disposed = false;
  #loadStarted = false;
  #leafVersion = 0;
  /** A search hit opened before the thread was read (CT15): shown once the entries are in. */
  #pendingHit: string | undefined;
  #lastStreamedRun: string | undefined;
  /**
   * KOBE-484: per streamed run, the seq this client already counts as history when it first
   * opened the run's stream (0 for runs this tab started; else the run's `last_seq` the server
   * reported, at least the resume point). Only `file.opened` events above it open a tab (and,
   * KOBE-489, only `file.edit_proposed` events above it may start a review by themselves).
   */
  readonly #historySeq = new Map<string, number>();
  readonly #ownRuns = new Set<string>();
  /** What the action modules see of this controller (KOBE-716). */
  readonly #port: SendPort;

  constructor(threadId: string | null, options: ControllerOptions) {
    this.#state = initialThreadState(threadId);
    this.#api = options.api;
    this.#eventSource = options.eventSource;
    this.#newKey = options.newKey ?? newIdempotencyKey;
    this.#reopenDelay = options.reopenDelayMs ?? ((n) => Math.min(1000 * 2 ** n, 15_000));
    this.#resume =
      options.resumeStore === null ? undefined : (options.resumeStore ?? browserResumeStore());
    this.#onRetitled = options.onRetitled;
    this.#onRunEvents = options.onRunEvents;
    this.#onLeafMoved = options.onLeafMoved;
    this.#port = {
      api: this.#api,
      state: () => this.#state,
      set: (change) => this.#set(change),
      busy: (action, fn) => this.#busy(action, fn),
      fail: (error, draft) => this.#fail(error, draft),
      announce: (text) => this.#announce(text),
      refresh: () => this.refresh(),
      bumpLeafVersion: () => {
        this.#leafVersion += 1;
      },
      leafMoved: (threadId) => this.#onLeafMoved?.(threadId),
      newKey: () => this.#newKey(),
      disposed: () => this.#disposed,
      ownRun: (runId) => this.#ownRuns.add(runId),
      startStream: (runId) => {
        this.#closeStream();
        this.#open(runId);
      },
    };
  }

  // --- store ----------------------------------------------------------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getState = (): ThreadState => this.#state;

  /** A run's token usage and spend (KOBE-43; run details). */
  readonly runUsage = (runId: string) => this.#api.runUsage(runId);

  /** Usage of each of this thread's runs (KOBE-208: the answers' footers); null for a draft. */
  readonly threadUsage = () => this.#ofThread((id) => this.#api.threadUsage(id));

  /** The thread's stored blocked-egress notices (KOBE-605); null for a draft. */
  readonly threadEgressBlocked = () => this.#ofThread((id) => this.#api.threadEgressBlocked(id));

  /** The context of this thread's latest model call (KOBE-471); null for a draft. */
  readonly threadContext = () => this.#ofThread((id) => this.#api.threadContext(id));

  /** The memories this thread's latest run was given (KOBE-382); null for a draft. */
  readonly threadContextMemories = () =>
    this.#ofThread((id) => this.#api.threadContextMemories(id));

  /** This thread's conversation stats (KOBE-842); null for a draft. */
  readonly threadStats = () => this.#ofThread((id) => this.#api.threadStats(id));

  /** How this thread's runs ended and its approvals were decided (KOBE-209); null for a draft. */
  readonly threadMarkers = () => this.#ofThread((id) => this.#api.threadMarkers(id));

  /** The thread's rateable answers and the member's own ratings (KOBE-275); null for a draft. */
  readonly threadFeedback = () => this.#ofThread((id) => this.#api.threadFeedback(id));

  /** Rates an answer of this thread for the member, or changes their rating (KOBE-275). */
  readonly rateAnswer = (runId: string, change: FeedbackChange) =>
    this.#api.rateAnswer(runId, change);

  /** Clears the member's rating of an answer (KOBE-275). */
  readonly clearRating = (runId: string) => this.#api.clearRating(runId);

  /** The preview of sharing an answer of this thread as an eval case (KOBE-276). */
  readonly previewEvalCase = (runId: string, options: EvalCaseOptions) =>
    this.#api.previewEvalCase(runId, options);

  /** Shares an answer as previewed (KOBE-276). */
  readonly shareEvalCase = (runId: string, options: EvalCaseOptions, digest: string) =>
    this.#api.shareEvalCase(runId, options, digest);

  /** Withdraws the member's eval case (KOBE-276). */
  readonly withdrawEvalCase = (caseId: string) => this.#api.withdrawEvalCase(caseId);

  /** A tool output of this thread in full (KOBE-208: a large one, when its card opens). */
  readonly toolOutput = (entryId: string) =>
    this.#ofThread((id) => this.#api.toolOutput(id, entryId));

  /** The member's budget status (KOBE-42; the chat's warning banner). */
  readonly budgetStatus = () => this.#api.budgetStatus();

  /** A read of the open thread; null for a draft. */
  #ofThread<T>(read: (threadId: string) => T): T | null {
    const id = this.#state.threadId;
    return id === null ? null : read(id);
  }

  #set(change: (state: ThreadState) => ThreadState): void {
    if (this.#disposed) return;
    const next = settleHead(settleStop(change(this.#state)));
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #announce(announcement: string): void {
    this.#set((s) => ({ ...s, announcement, announcementSeq: s.announcementSeq + 1 }));
  }

  #fail(error: ApiError, draft?: string): void {
    this.#set((s) => ({ ...s, actionError: { error, draft } }));
  }

  readonly clearError = (): void => {
    this.#set((s) => (s.actionError ? { ...s, actionError: undefined } : s));
  };

  async #busy<T>(action: string, fn: () => Promise<T>): Promise<T> {
    this.#set((s) => ({ ...s, busy: [...s.busy, action], actionError: undefined }));
    try {
      return await fn();
    } finally {
      this.#set((s) => ({ ...s, busy: s.busy.filter((a) => a !== action) }));
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------

  /** A thread created a moment ago (empty, idle): nothing to read. */
  seed(summary: ThreadSummary): void {
    this.#loadStarted = true;
    this.#set((s) => ({ ...s, phase: "ready", summary }));
  }

  /** Shows an error raised outside this controller (e.g. creating the thread failed). */
  readonly reportError = (error: ApiError, draft?: string): void => {
    this.#fail(error, draft);
  };

  /** Reads the thread, its runs and pending messages, then streams the run that holds it. */
  async load(): Promise<void> {
    const threadId = this.#state.threadId;
    if (threadId === null || this.#loadStarted) return;
    this.#loadStarted = true;
    const read = await readThread(this.#api, threadId, undefined, this.#port);
    if (read === undefined) return;
    if (!read.ok) {
      this.#loadStarted = false; // "Try again" may load again
      this.#set((s) => ({ ...s, phase: "error", loadError: read.error }));
      return;
    }
    const { summary, entries, agentModel, agentCurrentVersion } = read.data;
    this.#set((s) => ({
      ...s,
      phase: "ready",
      loadError: undefined,
      summary,
      agentModel,
      agentCurrentVersion,
      entries: mergeServerEntries(s.entries, entries),
      serverSeq: maxSeq(entries, s.serverSeq),
    }));
    const hit = this.#pendingHit;
    this.#pendingHit = undefined;
    if (hit !== undefined) this.showHit(hit);
    if (await this.#readRuns(threadId)) this.#syncStream();
  }

  /** "Try again" after the thread could not be read. */
  readonly retryLoad = (): void => {
    if (this.#loadStarted || this.#disposed) return;
    this.#set((s) => ({ ...s, phase: "loading", loadError: undefined }));
    void this.load();
  };

  /** Reads runs and pending messages; false (and an error shown) when the runs are unknown. */
  async #readRuns(threadId: string): Promise<boolean> {
    const [runs, pending] = await Promise.all([
      this.#api.listRuns(threadId),
      this.#api.pendingMessages(threadId),
    ]);
    if (this.#disposed) return false;
    if (runs.ok) this.#set((s) => withRuns(s, runs.data));
    else this.#fail(runs.error);
    if (!pending.ok) this.#fail(pending.error);
    else this.#set((s) => withPending(s, pending.data.messages));
    return runs.ok;
  }

  /** New entries, the summary (leaf, status), runs and pending messages; then the right stream. */
  readonly refresh = async (): Promise<void> => {
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      try {
        do {
          this.#refreshAgain = false;
          await this.#refreshOnce();
        } while (this.#refreshAgain && !this.#disposed);
      } finally {
        // Cleared in the same tick the loop ends, so no later call can be lost.
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  };

  async #refreshOnce(): Promise<void> {
    const threadId = this.#state.threadId;
    if (threadId === null || this.#disposed) return;
    const after = this.#state.serverSeq;
    const leafVersion = this.#leafVersion;
    const read = await readThread(this.#api, threadId, after, this.#port);
    if (read === undefined) return;
    if (!read.ok) {
      this.#fail(read.error);
      return;
    }
    const { summary, entries: incoming, agentModel, agentCurrentVersion } = read.data;
    this.#set((s) => ({
      ...s,
      agentModel,
      agentCurrentVersion,
      // A branch chosen while this read was on its way wins over the leaf it read.
      summary:
        leafVersion === this.#leafVersion || !s.summary
          ? summary
          : { ...summary, leafEntryId: s.summary.leafEntryId },
      entries: mergeServerEntries(s.entries, incoming),
      serverSeq: maxSeq(incoming, s.serverSeq),
    }));
    if (await this.#readRuns(threadId)) this.#syncStream();
  }

  /** Stops streaming (the thread is no longer on screen). */
  dispose(): void {
    this.#closeStream();
    this.#epilogue?.close();
    this.#epilogue = undefined;
    this.#disposed = true;
    this.#listeners.clear();
  }

  // --- streaming --------------------------------------------------------------------------------

  #closeStream(): void {
    if (this.#reopenTimer !== undefined) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = undefined;
    this.#stream?.close();
    this.#stream = undefined;
  }

  /** Streams the run that holds the thread, or the next queued run (to see it start). */
  #syncStream(): void {
    if (this.#disposed) return;
    const runId = runToStream(this.#state);
    if (runId === undefined) {
      this.#closeStream();
      this.#set((s) => (s.connection === "idle" ? s : { ...s, connection: "idle" }));
      return;
    }
    if (this.#stream?.runId === runId) return;
    this.#closeStream();
    // A run the server keeps refusing (reopened from here) keeps its backoff.
    if (this.#lastStreamedRun !== runId) this.#reopenAttempts = 0;
    this.#lastStreamedRun = runId;
    this.#set((s) => withStreamedRun(s, runId, this.#resume));
    this.#open(runId);
  }

  #open(runId: string): void {
    if (this.#disposed) return;
    const after = this.#state.live?.runId === runId ? this.#state.live.lastSeq : 0;
    if (!this.#historySeq.has(runId)) {
      this.#historySeq.set(runId, historyOf(this.#state, this.#ownRuns, runId, after));
    }
    this.#set((s) => ({ ...s, connection: "connecting" }));
    this.#stream = openRunStream(
      runId,
      after,
      {
        onEvents: (events) => this.#onEvents(runId, events),
        onSignal: (signal) => this.#onSignal(runId, signal),
      },
      this.#eventSource,
    );
  }

  #onEvents(runId: string, events: readonly KaijuEvent[]): void {
    const threadId = this.#state.threadId;
    if (threadId !== null) this.#onRunEvents?.(threadId, events);
    for (const event of events) {
      if (event.type === "thread.updated") this.#retitled(event.payload);
      if (event.type === "thread.suggestions") this.#suggested(runId, event.payload);
    }
    const live = this.#state.live;
    if (!live || live.runId !== runId) return;
    const wasStarted = live.started;
    const applied = applyRunEvents(live, events);
    const now = new Date().toISOString();
    const history = this.#historySeq.get(runId);
    const opened = liveFileRequest("file.opened", runId, live.lastSeq, history, events);
    const proposed = liveFileRequest("file.edit_proposed", runId, live.lastSeq, history, events);
    this.#set((s) => ({
      ...s,
      live: applied.run,
      entries: mergeCommittedEntries(s.entries, applied.entries, now),
      connection: "open",
      ...(opened === undefined ? {} : { fileOpenRequest: opened }),
      ...(proposed === undefined ? {} : { fileEditRequest: proposed }),
    }));
    const terminal = applied.run.terminal;
    if (terminal !== undefined) clearResumePoint(this.#resume, runId);
    else if (applied.entries.length > 0) saveResumePoint(this.#resume, applied.run);
    if (terminal !== undefined && live.terminal === undefined) {
      this.#onTerminal(terminal);
      return;
    }
    if (applied.run.started && !wasStarted) {
      // A queued run started: it leaves the queue and its prompt shows in the conversation.
      this.#set((s) => (s.followups ? { ...s, followups: undefined } : s));
      this.#announce("The agent is working on your message.");
      void this.refresh();
    } else if (mayBeUnsavedPrompt(this.#state, applied.entries)) {
      // A prompt over 64 KiB is streamed without its body (KOBE-288): read it, so the stored
      // entry replaces the copy shown from the send.
      void this.refresh();
    }
  }

  /**
   * The server's title for this thread (KOBE-219): the bar shows it at once, the rail reads it.
   * With `leaf_entry_id` (CT13): the leaf moved (another tab, a send's commit); a head at the old
   * leaf follows it, a browsed one stays (`settleHead`), and a read on its way keeps this leaf.
   */
  #retitled(payload: {
    readonly thread_id: string;
    readonly title?: string | undefined;
    readonly leaf_entry_id?: string | undefined;
  }): void {
    const { title, leaf_entry_id: leaf } = payload;
    if (payload.thread_id !== this.#state.threadId) return;
    if (leaf !== undefined) this.#leafMoved(leaf, true);
    if (title === undefined) return;
    this.#set((s) =>
      s.summary && s.summary.threadId === payload.thread_id
        ? { ...s, summary: { ...s.summary, title } }
        : s,
    );
    this.#onRetitled?.(payload.thread_id, title);
  }

  /**
   * The server's follow-ups after `runId` (KOBE-222): shown only while that run is still the
   * thread's latest and nothing was sent since (a late epilogue never brings old chips back).
   */
  #suggested(
    runId: string,
    payload: { readonly thread_id: string; readonly suggestions: readonly string[] },
  ): void {
    const s = this.#state;
    if (!followupsShown(s, runId, payload.thread_id)) return;
    this.#set((st) => ({ ...st, followups: { runId, suggestions: payload.suggestions } }));
    // Chips appear after the answer: screen readers hear about them (review N4).
    if (s.summary?.readOnly !== true) this.#announce("Follow-up suggestions are available.");
  }

  #onTerminal(terminal: NonNullable<ThreadState["live"]>["terminal"]): void {
    if (!terminal) return;
    const plan = planTerminal(terminal);
    if (plan.leaf !== undefined) this.#leafMoved(plan.leaf, false);
    this.#set((s) => ({
      ...s,
      announcement: plan.announcement,
      announcementSeq: s.announcementSeq + 1,
    }));
    if (plan.keepEpilogue) {
      this.#epilogue?.close();
      this.#epilogue = this.#stream;
    }
    this.#stream = undefined;
    void this.refresh();
  }

  /**
   * The leaf moved (a run's end, CT13's `thread.updated`): nothing when it is where it was; else
   * the summary follows, a read on its way keeps this leaf, a head at the old leaf follows it
   * (`settleHead`), and the follow-ups go when they belonged to the old leaf (`dropFollowups`).
   */
  #leafMoved(leaf: string, dropFollowups: boolean): void {
    const summary = this.#state.summary;
    if (!summary || summary.leafEntryId === leaf) return;
    this.#leafVersion += 1;
    this.#set((s) =>
      s.summary
        ? {
            ...s,
            ...(dropFollowups ? { followups: undefined } : {}),
            summary: { ...s.summary, leafEntryId: leaf },
          }
        : s,
    );
  }

  #onSignal(runId: string, signal: StreamSignal): void {
    const plan = planSignal(runId, signal, {
      streamRunId: this.#stream?.runId,
      epilogueRunId: this.#epilogue?.runId,
      live: this.#state.live,
    });
    if (plan.kind === "epilogue_closed") this.#epilogue = undefined;
    else if (plan.kind === "open") {
      this.#reopenAttempts = 0;
      this.#set((s) => ({ ...s, connection: "open" }));
    } else if (plan.kind === "reconnecting") {
      this.#set((s) => ({ ...s, connection: "reconnecting" }));
    } else if (plan.kind !== "ignore") {
      if (this.#stream?.runId === runId) this.#stream = undefined;
      if (plan.kind === "closed") void this.#afterClose(runId);
    }
  }

  /** The server ended or refused the stream before a terminal event: ask what the run is doing. */
  async #afterClose(runId: string): Promise<void> {
    const res = await this.#api.getRun(runId);
    if (this.#disposed) return;
    const plan = planAfterClose(res, this.#reopenAttempts, this.#reopenDelay);
    if (plan.kind === "refresh") {
      await this.refresh();
      return;
    }
    if (plan.kind === "lost") {
      this.#set((s) => ({ ...s, connection: "lost" }));
      if (plan.error !== undefined) this.#fail(plan.error);
      return;
    }
    this.#reopenAttempts = plan.attempts;
    this.#set((s) => ({ ...s, connection: "reconnecting" }));
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = undefined;
      if (!this.#disposed && this.#stream === undefined && runToStream(this.#state) === runId) {
        this.#open(runId);
      }
    }, plan.delayMs);
  }

  /** "Reconnect" after the stream was given up on. */
  readonly reconnect = (): void => {
    this.#reopenAttempts = 0;
    this.#closeStream();
    void this.refresh().then(() => {
      if (this.#disposed) return;
      const runId = runToStream(this.#state);
      if (runId !== undefined && this.#stream === undefined) this.#open(runId);
    });
  };

  // --- actions ----------------------------------------------------------------------------------

  /**
   * Sends a message (D17): starts a run on an idle thread, otherwise it queues. `parentEntryId`
   * branches from that entry (edit-and-regenerate); absent = continue from the leaf. The
   * Idempotency-Key makes the one automatic resend after a network error safe.
   */
  readonly send = async (
    text: string,
    parentEntryId?: string,
    attach?: MessageFiles,
    mentions?: readonly string[],
    appContext?: readonly AppContextWire[],
    skill?: string,
    viewing?: ViewingChoice,
    references?: readonly ItemReference[],
  ): Promise<boolean> => {
    try {
      const args: SendArgs = [
        text,
        parentEntryId,
        attach,
        mentions,
        appContext,
        skill,
        viewing,
        references,
      ];
      return await sendMessage(this.#port, ...args);
    } catch {
      // Whatever failed, the composer must not stay stuck: the message is offered back.
      this.#set((s) => ({ ...s, sending: undefined }));
      this.#fail(CLIENT_ERROR, text);
      return false;
    }
  };

  /** Steer now (D17): inject into the current run at Pi's next safe point. */
  readonly steer = (text: string, mentions?: readonly string[]): Promise<boolean> =>
    steerRun(this.#port, text, mentions, this.send);

  /** Stop (D17): cancels the current run; queued messages are held until "Resume queue". */
  readonly stop = (): Promise<void> => queue.stopRun(this.#port);

  readonly cancelQueued = (runId: string): Promise<void> => queue.cancelQueued(this.#port, runId);

  readonly editQueued = (runId: string, text: string): Promise<boolean> =>
    queue.editQueued(this.#port, runId, text);

  /** "Retry from last entry" (D14): a new run of the interrupted message, ahead of the queue. */
  readonly retry = (): Promise<void> => queue.retryInterrupted(this.#port);

  /** "Continue without retry" (D14): the interrupted thread's queue resumes. */
  readonly continueWithoutRetry = (): Promise<void> =>
    queue.resumeQueue(this.#port, "Continuing without retry.");

  /** "Resume queue" after Stop: the held messages run in order. */
  readonly resumeQueue = (): Promise<void> => queue.resumeQueue(this.#port, "The queue resumed.");

  /** Pause (CE10): the queued messages wait after the current run until resumed or a send. */
  readonly pauseQueue = (): Promise<void> => queue.pauseQueue(this.#port);

  /**
   * Reorder (CE10): `runIds` is the whole queue in its new order. Shown at once, with retries kept
   * first as the server keeps them (D14). The server's answer is applied as is; a stale list
   * (`queue_changed`) or any other refusal shows the error and reads the queue again.
   */
  readonly reorderQueue = (runIds: readonly string[]): Promise<void> =>
    queue.reorderQueue(this.#port, runIds);

  /**
   * Chooses the thread's model for its next runs (KOBE-44): an alias the team enabled, or null for
   * the team's default. The server refuses one the team didn't enable (`model_not_enabled`).
   */
  readonly setModel = (model: string | null): Promise<boolean> =>
    settings.setModel(this.#port, model);

  /**
   * Moves the thread to its agent's current version (D19, U8, KOBE-420): the next run uses it, and
   * the server marks the switch on that run. Refused while a run is active (`thread_busy`).
   */
  readonly switchAgentVersion = (): Promise<boolean> => settings.switchAgentVersion(this.#port);

  /**
   * Gives this agentless thread the agent picked in the composer (KOBE-458 ac-3): the next run uses
   * it and its connectors. Once only; refused while a run is active (`thread_busy`).
   */
  readonly chooseAgent = (agent: { readonly id: string; readonly name: string }) =>
    settings.chooseAgent(this.#port, agent);

  /**
   * Chooses the thread's thinking level for its next runs (KOBE-260); null = the model's default.
   * Each run is clamped to the site and team settings of its model by the server.
   */
  readonly setThinkingLevel = (level: ThinkingLevel | null): Promise<boolean> =>
    settings.setThinkingLevel(this.#port, level);

  /**
   * Regenerate with another model (CE17, KOBE-217): saves `model` as the thread's (null: follow
   * the team default), as the picker does, then sends `text` from `parentEntryId` as a new
   * version. Refused unless `canRegenerateWith`, so two choices can't race. A refused model
   * change runs nothing; a message that doesn't go puts the previous model back and keeps the
   * failure in the banner, so the thread is never left switched without its new version.
   */
  readonly regenerateWith = (
    model: string | null,
    text: string,
    parentEntryId: string,
    promptEntryId?: string,
    references?: readonly ItemReference[],
  ): Promise<boolean> =>
    settings.regenerateWith(this.#port, this.send, this.setModel, {
      model,
      text,
      parentEntryId,
      promptEntryId,
      references,
    });

  /**
   * Shares the thread with its project or the team, or makes it private again (owner only; the
   * server decides).
   */
  readonly setVisibility = (visibility: ThreadVisibility): Promise<boolean> =>
    settings.setVisibility(this.#port, visibility);

  /**
   * Compact now (CE15, KOBE-213): Pi summarizes the older conversation (optional focus); the
   * thread is then read again, so its `compaction` marker shows the summary. A refusal (the
   * server's fixed message per code) is reported like any action's, so it is seen even when the
   * dialog was closed meanwhile, and the thread is read again (a `thread_busy` means it changed).
   */
  readonly compact = (focus?: string): Promise<ApiResult<CompactResult>> =>
    settings.compact(this.#port, focus);

  /**
   * Make it current and carry a summary (KOBE-548, CT11): Pi summarizes the branch the thread
   * leaves and puts the summary under `target` (a node off the leaf's branch: the web refuses one
   * on it); the summary is the new leaf, so the head follows it and the thread is read again. A
   * refusal shows in the dialog (and, except `thread_busy`, as the thread's error); no re-read.
   */
  readonly carrySummary = (
    target: string,
    focus?: string,
  ): Promise<ApiResult<BranchSummaryResult> | undefined> =>
    branches.carrySummary(this.#port, target, focus);

  /**
   * Forks the thread (any reader, or the owner) and returns the new thread's id: up to an entry
   * with a title ("Fork to a new thread", CE16), or the whole branch by default. A refusal is
   * the caller's to show (the fork dialog, the read-only banner), not the thread's error banner.
   */
  readonly fork = (options?: ForkOptions): Promise<ApiResult<{ threadId: string }>> =>
    settings.fork(this.#port, options);

  /** Shows another branch (assistant-ui's branch picker) and makes it the thread's leaf. */
  readonly switchLeaf = (entryId: string): Promise<void> =>
    branches.switchLeaf(this.#port, entryId);

  // --- the local head (CT3, KOBE-544) ----------------------------------------------------------

  /**
   * Shows the newest branch at or below an entry (the tree, KOBE-546); the leaf stays. `reveal`:
   * the entry to scroll to once it shows (the tree's node).
   */
  readonly showBranch = (entryId: string, reveal?: string): void =>
    branches.showBranch(this.#port, entryId, reveal);

  /** Scrolls the conversation to an entry already on screen (the tree's node, KOBE-546). */
  readonly reveal = (entryId: string): void => branches.reveal(this.#port, entryId);

  /** Shows the version a reader's branch picker chose, ending at that entry (never writes). */
  readonly showVersion = (entryId: string): void => branches.showVersion(this.#port, entryId);

  /**
   * Continue from here (CT8, KOBE-546): the conversation shows the path through the answer (the
   * head stays when the answer is on screen, else moves to the newest branch below it), scrolled
   * to it; the next send continues from `entryId` (the answer's last entry). Nothing is written.
   */
  readonly continueFrom = (entryId: string): void =>
    branches.continueFromAnswer(this.#port, entryId);

  /** Escape, the chip's ✕, another thread: the next send continues the branch on screen again. */
  readonly clearContinue = (): void => branches.clearContinue(this.#port);

  /** A line for the chat's polite region (the tree's "Label saved", KOBE-546). */
  readonly announce = (text: string): void => this.#announce(text);

  /** ✕ on the bar: back to the leaf's branch. */
  readonly showLeaf = (): void => branches.moveHead(this.#port, undefined);

  /**
   * A search hit opened (CT15): off the leaf's branch, the head moves to the hit's branch; either
   * way the conversation scrolls to it. Before the thread is read, it waits for the read.
   */
  readonly showHit = (entryId: string): void => {
    if (this.#state.phase !== "ready") {
      this.#pendingHit = entryId;
      return;
    }
    branches.showHitNow(this.#port, entryId);
  };

  /**
   * Make it current (owner): the leaf moves to the head's branch, one `POST /leaf`, never retried.
   * The answer is the caller's (the bar shows `thread_busy` as its own note); other refusals show
   * as the thread's error. The follow-ups go, as on any branch switch.
   */
  readonly makeCurrent = (
    /** The tree's node (KOBE-546): its newest branch, without browsing it first. */
    entryId?: string,
  ): Promise<ApiResult<ThreadSummary> | undefined> => branches.makeCurrent(this.#port, entryId);
}
