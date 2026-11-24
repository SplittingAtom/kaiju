/**
 * The thread's history as a controller reads it (pure planners, KOBE-716): runs and pending
 * messages folded into the state, where a run's history ends, and which live file events are new.
 */
import type { KaijuEvent } from "@kaiju/protocol";
import type { ApiError, ApiResult } from "../../api/client";
import type { ChatApi } from "../api";
import { newLiveRun, type CommittedEntry } from "../live";
import { loadResumePoint, type ResumeStore } from "../resume";
import { promptSaved, type ThreadState } from "../thread-state";
import type { PendingMessage, ThreadEntry, ThreadRuns, ThreadSummary } from "../types";

const MAX_ENTRY_PAGES = 40;
const PARTIAL_HISTORY = "Part of this conversation could not be loaded. Reload to see all of it.";

/** A thread read in full: its summary, every entry page after `after`, its agent's pins. */
export interface ThreadRead {
  readonly summary: ThreadSummary;
  readonly entries: readonly ThreadEntry[];
  readonly agentModel: string | null;
  readonly agentCurrentVersion: number | null;
}

/**
 * Reads the thread and the entry pages after the first (up to 40); a page that fails keeps what
 * was read (a valid prefix of the tree) and says the rest is missing. Undefined once disposed.
 */
export async function readThread(
  api: ChatApi,
  threadId: string,
  after: number | undefined,
  ctl: { disposed(): boolean; fail(error: ApiError): void },
): Promise<ApiResult<ThreadRead> | undefined> {
  const detail = await (after === undefined
    ? api.getThread(threadId)
    : api.getThread(threadId, after));
  if (ctl.disposed()) return undefined;
  if (!detail.ok) return detail;
  const {
    entries: first,
    nextEntriesAfter,
    agentCurrentVersion,
    agentModel,
    ...summary
  } = detail.data;
  const entries = [...first];
  let next = nextEntriesAfter;
  for (let page = 0; next !== null && page < MAX_ENTRY_PAGES; page++) {
    const res = await api.listEntries(threadId, next);
    if (ctl.disposed()) break;
    if (!res.ok) {
      ctl.fail({ ...res.error, message: PARTIAL_HISTORY });
      break;
    }
    entries.push(...res.data.entries);
    next = res.data.nextEntriesAfter;
  }
  if (ctl.disposed()) return undefined;
  const data = { summary, entries, agentModel: agentModel ?? null, agentCurrentVersion };
  return { ok: true, status: detail.status, data };
}

/** The run about to be streamed as the live one, resumed after what the entries already hold. */
export function withStreamedRun(
  s: ThreadState,
  runId: string,
  resume: ResumeStore | undefined,
): ThreadState {
  if (s.live?.runId === runId) return s;
  const prompt = s.pending.find((m) => m.runId === runId);
  return {
    ...s,
    // After a reload, resume after what the entries already hold (else replay from 0).
    live:
      loadResumePoint(resume, runId, new Set(s.entries.map((e) => e.entryId))) ?? newLiveRun(runId),
    livePrompt: prompt ? { text: prompt.content, parentEntryId: prompt.parentEntryId } : undefined,
  };
}

/** The server's run list in the state; the queue's pause flag kept as the server or Stop set it. */
export function withRuns(s: ThreadState, data: ThreadRuns): ThreadState {
  const active = data.runs.some((r) => r.status === "running" || r.status === "waiting_approval");
  const queued = data.runs.some((r) => r.status === "queued");
  // The server's flag when it sends one; otherwise ours holds until a run starts or the queue empties.
  const queuePaused = data.queuePaused ?? (s.queuePaused && !active && queued);
  return { ...s, runs: data.runs, interruptedRun: data.interruptedRun, queuePaused };
}

/** The pending messages in the state; the live run's prompt comes from its pending message. */
export function withPending(s: ThreadState, messages: readonly PendingMessage[]): ThreadState {
  const live = s.live;
  const prompt = live ? messages.find((m) => m.runId === live.runId) : undefined;
  return {
    ...s,
    pending: messages,
    livePrompt:
      prompt !== undefined
        ? { text: prompt.content, parentEntryId: prompt.parentEntryId, files: s.livePrompt?.files }
        : s.livePrompt,
  };
}

export function maxSeq(entries: readonly ThreadEntry[], floor: number): number {
  return entries.reduce((max, e) => Math.max(max, e.seq), floor);
}

/**
 * Where history ends for a run whose stream opens now: nothing for a run this tab started;
 * else the server's `last_seq` from the run list (a reload's or another tab's run), never below
 * the resume point; unknown (older server) means everything already sent is history.
 */
export function historyOf(
  s: Pick<ThreadState, "runs" | "interruptedRun">,
  ownRuns: ReadonlySet<string>,
  runId: string,
  after: number,
): number {
  if (ownRuns.has(runId)) return 0;
  const snapshot = [...s.runs, s.interruptedRun].find((r) => r?.runId === runId);
  return Math.max(after, snapshot?.lastSeq ?? Number.POSITIVE_INFINITY);
}

/**
 * The newest `file.opened` (KOBE-484) or `file.edit_proposed` (KOBE-489) of this batch that is
 * new to this client and above the run's history (`historySeq`, unknown: everything): a replayed
 * backlog never opens a tab, live events do.
 */
export function liveFileRequest(
  type: "file.opened" | "file.edit_proposed",
  runId: string,
  afterSeq: number,
  historySeq: number | undefined,
  events: readonly KaijuEvent[],
): ThreadState["fileOpenRequest"] {
  const history = Math.max(afterSeq, historySeq ?? Number.POSITIVE_INFINITY);
  const last = events.findLast((e) => e.type === type && e.seq > history);
  if (last?.type !== "file.opened" && last?.type !== "file.edit_proposed") return undefined;
  return { runId, toolCallId: last.payload.tool_call_id, path: last.payload.path };
}

/**
 * A body-less message entry that may be the run's prompt: no stream message bound to it (an
 * answer has one) while the prompt is not known to be saved. Large answers and tool outputs
 * once the prompt is saved are left to the reads that follow the run.
 */
export function mayBeUnsavedPrompt(s: ThreadState, entries: readonly CommittedEntry[]): boolean {
  if (s.live === undefined || s.livePrompt === undefined || promptSaved(s.live, s.entries)) {
    return false;
  }
  return entries.some(
    (e) => e.payload === undefined && e.type === "message" && e.messageId === undefined,
  );
}
