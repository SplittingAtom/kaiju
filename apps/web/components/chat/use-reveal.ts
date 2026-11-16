"use client";

import { useEffect, useRef } from "react";
import { onRevealRequest } from "../../lib/chat/reveal-request";
import type { ThreadState } from "../../lib/chat/thread-state";
import type { Projection } from "../../lib/chat/tree";

/** Frames to wait for the hit's message to render (the branch shows on the next commit). */
const MAX_FRAMES = 20;

/**
 * Scrolls to a search hit's message once the conversation shows it (CT15): on each new
 * `state.reveal`, the message holding the entry is found by assistant-ui's `data-message-id`
 * inside this thread view's message list (`root`), never in another mounted view.
 */
export function useReveal(
  state: ThreadState,
  projection: Projection,
  root: HTMLElement | null,
): void {
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const seq = state.reveal?.seq;
  const entryId = state.reveal?.entryId;
  useEffect(() => {
    if (entryId === undefined) return;
    let frame = 0;
    let handle = 0;
    const tryScroll = () => {
      const node = projectionRef.current.nodeOfEntry.get(entryId);
      const el =
        node === undefined
          ? null
          : (root?.querySelector(`[data-message-id="${CSS.escape(node)}"]`) ?? null);
      if (el) {
        el.scrollIntoView({ block: "center" });
        flash(el);
        return;
      }
      frame += 1;
      if (frame < MAX_FRAMES) handle = requestAnimationFrame(tryScroll);
    };
    handle = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(handle);
  }, [seq, entryId, root]);
}

/** A short highlight of the revealed message; none when the person asked for less motion. */
function flash(el: Element): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate?.(
    [
      { outline: "3px solid var(--kobe-status-accent, currentColor)" },
      { outline: "3px solid transparent" },
    ],
    { duration: 1600, easing: "ease-out" },
  );
}

/**
 * Reveal requests from outside the thread view (`lib/chat/reveal-request.ts`; To review's
 * evidence quotes, KOBE-396): the controller scrolls to the entry when this view shows its thread.
 */
export function useRevealRequests(
  threadId: string | null,
  controller: { readonly reveal: (entryId: string) => void } | null,
): void {
  useEffect(() => {
    if (threadId === null || controller === null) return;
    return onRevealRequest(threadId, controller.reveal);
  }, [threadId, controller]);
}
