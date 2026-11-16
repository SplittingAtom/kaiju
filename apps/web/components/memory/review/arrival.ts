"use client";

import { useEffect, useRef } from "react";

/**
 * When a learning pass finishes (KOBE-396, SM16): To review **opens by itself** when the person is
 * on the pass's thread and no other panel is open; otherwise the candidates wait, counted on `+`
 * and in the bell (the server's `memory.review.candidates_ready` notice, written with the pass).
 * Opening by itself marks that notice read, so the bell counts only what the person hasn't seen.
 *
 * The pass UI (KOBE-395, the `+` menu's Learn) reads the pass events and calls
 * {@link announcePassCompleted}; {@link useReviewArrival} (mounted once in the workspace) decides.
 */

export interface PassCompleted {
  readonly threadId: string;
  readonly passId: string;
  /** Candidates the pass left in To review. */
  readonly candidates: number;
}

export type Arrival = "open" | "wait" | "none";

/** Pure: what a finished pass does on this screen. */
export function arrivalFor(
  pass: PassCompleted,
  screen: { readonly threadId: string | undefined; readonly panelOpen: boolean },
): Arrival {
  if (pass.candidates <= 0) return "none";
  return screen.threadId === pass.threadId && !screen.panelOpen ? "open" : "wait";
}

const EVENT = "kobe:memory-pass-completed";

/** Tells the workspace a pass finished (the pass UI calls this on `memory.pass.completed`). */
export function announcePassCompleted(pass: PassCompleted): void {
  window.dispatchEvent(new CustomEvent<PassCompleted>(EVENT, { detail: pass }));
}

/** To review's address: the Memory panel, Memories tab (its To review section is on top). */
export const REVIEW_HREF = "/me/memory?review=1";

/**
 * Opens To review for a finished pass when {@link arrivalFor} says so, and marks the pass's bell
 * notice read (`seen`); `onWait` hears about the others (the `+` count).
 */
export function useReviewArrival(options: {
  readonly threadId: string | undefined;
  readonly panelOpen: boolean;
  readonly open: (href: string) => void;
  readonly seen: (threadId: string) => void;
  readonly onWait?: (pass: PassCompleted) => void;
}): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const on = (e: Event) => {
      const pass = (e as CustomEvent<PassCompleted>).detail;
      const o = latest.current;
      const arrival = arrivalFor(pass, { threadId: o.threadId, panelOpen: o.panelOpen });
      if (arrival === "open") {
        o.open(REVIEW_HREF);
        o.seen(pass.threadId);
      } else if (arrival === "wait") o.onWait?.(pass);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
