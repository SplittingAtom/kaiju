"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import type { DraftClient } from "../../lib/skills/draft-client";
import type { Changed, DraftFileInfo, DraftSummary } from "../../lib/skills/drafts-api";
import {
  byteLength,
  SAVE_IDLE_MS,
  SAVE_MAX_WAIT_MS,
  UNSAVED,
  type SaveStatus,
} from "./draft-editor-model";

export interface WriterInput {
  readonly api: DraftClient;
  readonly id: string;
  readonly rev: MutableRefObject<number>;
  readonly rescan: () => void;
  readonly setDraft: Dispatch<SetStateAction<DraftSummary | null>>;
  readonly setFiles: Dispatch<SetStateAction<readonly DraftFileInfo[]>>;
  readonly setStatus: Dispatch<SetStateAction<SaveStatus>>;
  readonly setError: Dispatch<SetStateAction<ApiError | null>>;
}

type Timer = MutableRefObject<ReturnType<typeof setTimeout> | null>;

function clearTimers(timers: readonly Timer[]) {
  for (const t of timers) {
    if (t.current) clearTimeout(t.current);
    t.current = null;
  }
}

/**
 * The editor's write path: the pending edits, the one queue every change of the draft runs in,
 * the autosave timers and the failure handling (a stale revision stops autosave).
 */
export function useDraftWriter({
  api,
  id,
  rev,
  rescan,
  setDraft,
  setFiles,
  setStatus,
  setError,
}: WriterInput) {
  const pending = useRef(new Map<string, string>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  /** Runs `op` after every change queued before it. */
  const enqueue = useCallback(<T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(op, op);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const changed = useCallback((res: Changed) => {
    rev.current = res.rev;
    setDraft(res.draft);
  }, []);

  const failed = useCallback((err: ApiError) => {
    setError(err);
    if (err.code === "stale_revision") stopped.current = true;
    setStatus(err.code === "stale_revision" ? "conflict" : "error");
  }, []);

  /** Writes the pending edits (inside the queue); the revision after them, or null. */
  const writePending = useCallback(async (): Promise<number | null> => {
    let wrote = false;
    while (pending.current.size > 0 && !stopped.current) {
      const [path, text] = pending.current.entries().next().value as [string, string];
      pending.current.delete(path);
      setStatus("saving");
      const res = await api.put(id, path, rev.current, text);
      if (!res.ok) {
        if (!pending.current.has(path)) pending.current.set(path, text);
        failed(res.error);
        return null;
      }
      changed(res.data);
      wrote = true;
      setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, size: byteLength(text) } : f)));
    }
    if (stopped.current) return null;
    setError(null);
    setStatus(pending.current.size > 0 ? "pending" : "saved");
    // Only a write makes a new revision to scan (a flush before Save version may write nothing).
    if (wrote) rescan();
    return rev.current;
  }, [api, id, changed, failed, rescan]);

  const flush = useCallback((): Promise<number | null> => {
    clearTimers([idleTimer, maxTimer]);
    return enqueue(writePending);
  }, [enqueue, writePending]);

  /** A change of the draft, in the queue: the pending edits are written first. */
  const change = useCallback(
    <T>(write: (rev: number) => Promise<ApiResult<T>>, apply: (data: T) => void) => {
      clearTimers([idleTimer, maxTimer]);
      return enqueue(async (): Promise<ApiError | null> => {
        if ((await writePending()) === null) return UNSAVED;
        const res = await write(rev.current);
        if (!res.ok) {
          if (res.error.code === "stale_revision") failed(res.error);
          return res.error;
        }
        apply(res.data);
        rescan();
        return null;
      });
    },
    [enqueue, writePending, failed, rescan],
  );

  const schedule = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => void flush(), SAVE_IDLE_MS);
    maxTimer.current ??= setTimeout(() => void flush(), SAVE_MAX_WAIT_MS);
  }, [flush]);
  return {
    pending,
    stopped,
    idleTimer,
    maxTimer,
    enqueue,
    changed,
    failed,
    flush,
    change,
    schedule,
  };
}

/** Closing the tab with unsaved edits asks first; leaving the editor in the app writes them. */
export function useFlushOnLeave(
  pending: MutableRefObject<Map<string, string>>,
  flush: () => Promise<number | null>,
  idleTimer: Timer,
  maxTimer: Timer,
) {
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      // The queue outlives the page: pending edits are written after it has gone.
      if (pending.current.size > 0) void flushRef.current();
      for (const t of [idleTimer, maxTimer]) if (t.current) clearTimeout(t.current);
    };
  }, []);
}
