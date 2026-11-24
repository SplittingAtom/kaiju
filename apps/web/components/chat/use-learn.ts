"use client";

import type { LearnMode } from "@kaiju/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { getLearnState, learnBlocker, startLearn, type LearnState } from "../../lib/chat/learn-api";
import { LEARN_TIMEOUT_MESSAGE, learnStep, type LearnWatch } from "../../lib/chat/learn-watch";
import { announcePassCompleted } from "../memory/review/arrival";
import { useChatSession } from "./kaiju-runtime";

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
    ? "Kaiju found nothing new to remember in this chat."
    : `Kaiju found ${n === 1 ? "1 thing" : `${n} things`} to review. Open To review to save or dismiss.`;

/**
 * Learn from this chat (KOBE-395) for the thread on screen: its state (read when the thread
 * opens and each time a run on it ends, every {@link LEARN_POLL_MS} while a pass runs, and again
 * when the tab comes back or the network returns), starting a pass, and a notice for what happened
 * (started, refused with the server's reason, finished). The state is Postgres's, so it is the same
 * whichever replica answers (KOBE-661); a pass that seems to run too long stops the spinner with
 * Try again ({@link learnStep}).
 */
export function useLearn(threadId: string | null, threadRunning: boolean): Learn {
  const session = useChatSession();
  const [state, setState] = useState<LearnState | null>(null);
  const [notice, setNotice] = useState<LearnNotice>({ text: "", n: 0 });
  const say = useCallback((text: string) => setNotice((s) => ({ text, n: s.n + 1 })), []);
  const current = useRef<string | null>(threadId);
  current.current = threadId;
  const watched = useRef<LearnWatch | null>(null);
  const abandoned = useRef<Set<string>>(new Set());
  // Bumped by each start: a read sent before it can't end the pass it started.
  const epoch = useRef(0);

  const refresh = useCallback(
    async (estimate = false) => {
      if (threadId === null) return;
      const sent = epoch.current;
      const res = await getLearnState(session.teamId, threadId, { estimate });
      if (current.current !== threadId || sent !== epoch.current) return;
      if (!res.ok) {
        setState(null);
        return;
      }
      const step = learnStep(watched.current, res.data, Date.now(), abandoned.current);
      watched.current = step.kind === "running" ? step.watch : null;
      if (step.kind === "ended") {
        // A pass this tab watched has ended: say how it went.
        say(step.failure ?? found(step.state.candidates));
        // KOBE-396: To review opens by itself when this thread is on screen and no panel is open.
        if (step.failure === null)
          announcePassCompleted({
            threadId,
            passId: step.passId,
            candidates: step.state.candidates,
          });
        const later = step.state.running;
        if (later !== null) watched.current = { passId: later.passId, since: Date.now() };
      } else if (step.kind === "timeout") {
        abandoned.current.add(step.passId);
        say(LEARN_TIMEOUT_MESSAGE);
      }
      setState(step.state);
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
    // A sleeping tab or a dropped connection misses polls: read again as soon as it is back.
    const again = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
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
      epoch.current += 1;
      watched.current = { passId: res.data.passId, since: Date.now() };
      setState((s) =>
        s === null
          ? s
          : { ...s, running: { passId: res.data.passId, startedAt: new Date().toISOString() } },
      );
      say(
        res.data.input.partial
          ? "Kaiju is learning from this chat. Some earlier messages were compacted and left out."
          : "Kaiju is learning from this chat.",
      );
    },
    [state, threadId, session.teamId, say, refresh],
  );

  const clearNotice = useCallback(() => setNotice((s) => ({ ...s, text: "" })), []);
  return { state, notice, start, refresh, clearNotice };
}
