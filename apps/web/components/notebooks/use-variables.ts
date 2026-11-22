"use client";

/**
 * The Variables tab's data (KOBE-804, route KOBE-803): the kernel's variables, asked live from the
 * sandbox and kept only in this tab's memory. Asked when the tab is shown and the thread's newest
 * finished run differs from the one the last answer followed (so after each run, the agent's
 * included), and by Refresh (a fresh snapshot). Never asked while code runs: the last values stay,
 * marked stale. A shared reader never asks (only the owner may).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { VariablesResult, VariablesSnapshot } from "../../lib/notebooks/variables";
import type { KernelWiring } from "./use-kernel";

export interface VariablesState {
  readonly loading: boolean;
  /** The last snapshot (kept across a `busy` or `unavailable` answer, dropped on `no_kernel`). */
  readonly snapshot: VariablesSnapshot | null;
  /** The last answer when it was not a snapshot. */
  readonly missing: Exclude<VariablesResult, VariablesSnapshot>["status"] | null;
  readonly autoPaused: boolean;
  readonly error: ApiError | null;
}

/** How long an ask after a run waits for more runs to finish first. */
export const FOLLOW_DELAY_MS = 1_000;

const EMPTY: VariablesState = {
  loading: false,
  snapshot: null,
  missing: null,
  autoPaused: false,
  error: null,
};

function next(state: VariablesState, result: VariablesResult): VariablesState {
  const autoPaused = result.autoPaused === "snapshot_timeout";
  if (result.status === "ok") {
    return { loading: false, snapshot: result, missing: null, autoPaused, error: null };
  }
  return {
    loading: false,
    snapshot: result.status === "no_kernel" ? null : state.snapshot,
    missing: result.status,
    autoPaused,
    error: null,
  };
}

export function useVariables({
  wiring,
  active,
  busy,
  followKey,
}: {
  readonly wiring: KernelWiring | undefined;
  /** The tab is shown. */
  readonly active: boolean;
  /** Code runs in the thread's kernel now. */
  readonly busy: boolean;
  /** The thread's newest finished execution ("" before any). */
  readonly followKey: string;
}) {
  const threadId = wiring?.threadId ?? null;
  const allowed = wiring !== undefined && threadId !== null && wiring.readOnly !== true;
  const [state, setState] = useState<{ thread: string | null; value: VariablesState }>({
    thread: threadId,
    value: EMPTY,
  });
  const asked = useRef<{ thread: string | null; key: string | null }>({ thread: null, key: null });
  const value = state.thread === threadId ? state.value : EMPTY;
  // Only the newest ask's answer counts.
  const latest = useRef(0);

  const ask = useCallback(
    async (refresh: boolean) => {
      if (!allowed || threadId === null || wiring === undefined) return;
      const mine = ++latest.current;
      setState((s) => ({
        thread: threadId,
        value: { ...(s.thread === threadId ? s.value : EMPTY), loading: true, error: null },
      }));
      const res = await wiring.api.variables(threadId, refresh);
      setState((s) => {
        if (s.thread !== threadId || mine !== latest.current) return s;
        return {
          thread: threadId,
          value: res.ok
            ? next(s.value, res.data)
            : { ...s.value, loading: false, error: res.error },
        };
      });
    },
    [allowed, threadId, wiring],
  );

  useEffect(() => {
    if (!active || !allowed || busy) return;
    if (asked.current.thread === threadId && asked.current.key === followKey) return;
    const go = () => {
      asked.current = { thread: threadId, key: followKey };
      void ask(false);
    };
    // The first ask goes at once; one after a run waits a moment, so a burst of short runs (an
    // agent's loop) costs one ask, not one each (review L7: the route allows 60 a minute).
    if (asked.current.thread !== threadId) return go();
    const timer = setTimeout(go, FOLLOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, allowed, busy, threadId, followKey, ask]);

  const refresh = useCallback(() => {
    asked.current = { thread: threadId, key: followKey };
    void ask(true);
  }, [ask, threadId, followKey]);

  return { ...value, allowed, refresh };
}
