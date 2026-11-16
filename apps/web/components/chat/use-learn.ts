"use client";

import type { LearnMode } from "@kobe/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { getLearnState, learnBlocker, startLearn, type LearnState } from "../../lib/chat/learn-api";
import { useChatSession } from "./kobe-runtime";

/** How often a running pass is checked on. */
export const LEARN_POLL_MS = 2_000;
/** How long a Learn notice stays on screen. */
export const LEARN_NOTICE_MS = 6_000;

export interface LearnNotice {
  readonly text: string;
  /** Bumped per notice, so a repeated sentence is a change screen readers announce. */
  readonly n: number;
}

export interface Learn {
  /** The thread's Learn state; null before it is read (and for a conversation not started). */
  readonly state: LearnState | null;
  readonly notice: LearnNotice;
  start(mode: LearnMode): Promise<void>;
  /** Reads the state again; with `estimate` also the token estimates (the menu opening). */
  refresh(estimate?: boolean): Promise<void>;
  clearNotice(): void;
}

const found = (n: number) =>
  n === 0
    ? "Kobe found nothing new to remember in this chat."
    : `Kobe found ${n === 1 ? "1 thing" : `${n} things`} to review. Open To review to save or dismiss.`;

/**
 * Learn from this chat (KOBE-395) for the thread on screen: its state (read when the thread
 * opens and each time a run on it ends, every {@link LEARN_POLL_MS} while a pass runs), starting a
 * pass, and a notice for what happened (started, refused with the server's reason, finished).
 */
export function useLearn(threadId: string | null, threadRunning: boolean): Learn {
  const session = useChatSession();
  const [state, setState] = useState<LearnState | null>(null);
  const [notice, setNotice] = useState<LearnNotice>({ text: "", n: 0 });
  const say = useCallback((text: string) => setNotice((s) => ({ text, n: s.n + 1 })), []);
  const current = useRef<string | null>(threadId);
  current.current = threadId;
  const watched = useRef<string | null>(null);

  const refresh = useCallback(
    async (estimate = false) => {
      if (threadId === null) return;
      const res = await getLearnState(session.teamId, threadId, { estimate });
      if (current.current !== threadId) return;
      if (!res.ok) {
        setState(null);
        return;
      }
      const next = res.data;
      // A pass this tab watched has ended: say how it went.
      const passId = watched.current;
      if (passId !== null && next.running?.passId !== passId) {
        watched.current = null;
        say(
          next.lastFailure?.passId === passId ? next.lastFailure.message : found(next.candidates),
        );
      }
      if (next.running !== null) watched.current = next.running.passId;
      setState(next);
    },
    [session.teamId, threadId, say],
  );

  useEffect(() => {
    setState(null);
    watched.current = null;
  }, [threadId]);

  useEffect(() => {
    if (!threadRunning) void refresh();
  }, [refresh, threadRunning]);

  const runningId = state?.running?.passId;
  useEffect(() => {
    if (runningId === undefined) return undefined;
    const timer = setInterval(() => void refresh(), LEARN_POLL_MS);
    return () => clearInterval(timer);
  }, [runningId, refresh]);

  useEffect(() => {
    if (notice.text === "") return undefined;
    const timer = setTimeout(() => setNotice((s) => ({ ...s, text: "" })), LEARN_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const start = useCallback(
    async (mode: LearnMode) => {
      const blocked = learnBlocker(state, mode);
      if (threadId === null || blocked !== null) {
        say(blocked ?? "Send a message first.");
        return;
      }
      const res = await startLearn(session.teamId, threadId, mode);
      if (!res.ok) {
        say(res.error.message);
        void refresh();
        return;
      }
      watched.current = res.data.passId;
      setState((s) =>
        s === null
          ? s
          : { ...s, running: { passId: res.data.passId, startedAt: new Date().toISOString() } },
      );
      say(
        res.data.input.partial
          ? "Kobe is learning from this chat. Some earlier messages were compacted and left out."
          : "Kobe is learning from this chat.",
      );
    },
    [state, threadId, session.teamId, say, refresh],
  );

  const clearNotice = useCallback(() => setNotice((s) => ({ ...s, text: "" })), []);
  return { state, notice, start, refresh, clearNotice };
}
