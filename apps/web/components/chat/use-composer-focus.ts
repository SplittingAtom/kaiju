"use client";

import { useEffect, type RefObject } from "react";
import {
  LAYER_CLOSE_WAIT_MS,
  autoFocusComposer,
  coarsePointer,
  focusRequest,
  focusVerdict,
} from "../../lib/chat/composer-focus";

/** The page's first focus request (its load) has happened: later ones are thread switches. */
let loadHandled = false;

/** Tests start each case as a fresh page load. */
export function resetComposerFocusForTests(): void {
  loadHandled = false;
}

/**
 * Moves the focus to the composer when `threadKey` comes on screen (KOBE-840): the page's load,
 * New chat (a new draft's key) and another conversation chosen from the Threads panel, the palette
 * or a search hit. Two frames later, as `focusComposerSoon` does, so the thread's content and the
 * layer it was chosen in have settled; while a dialog or menu is still open it waits for that to
 * close, up to `LAYER_CLOSE_WAIT_MS`. It never takes the focus from another field, never over a
 * layer left open, and on a touch screen not at page load (no keyboard popping up). Only the focus
 * moves: the thread's polite announcements (`state.announcement`, the document title) still come.
 */
export function useComposerAutoFocus(
  input: RefObject<HTMLTextAreaElement | null>,
  threadKey: string | undefined,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const atLoad = !loadHandled;
    loadHandled = true;
    if (atLoad && coarsePointer(window)) return undefined;
    const started = performance.now();
    const request = focusRequest(document, atLoad);
    let frame = 0;
    // A key or a press after the request is the member's own next step: the request ends.
    const stop = () => cancelAnimationFrame(frame);
    const attempt = () => {
      const composer = input.current;
      const verdict = focusVerdict(document, composer, request);
      if (verdict === "focus" && composer !== null) autoFocusComposer(composer);
      else if (verdict === "wait" && performance.now() - started < LAYER_CLOSE_WAIT_MS) {
        frame = requestAnimationFrame(attempt);
      }
    };
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(attempt);
    });
    document.addEventListener("keydown", stop, true);
    document.addEventListener("pointerdown", stop, true);
    return () => {
      stop();
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("pointerdown", stop, true);
    };
  }, [input, threadKey, enabled]);
}
