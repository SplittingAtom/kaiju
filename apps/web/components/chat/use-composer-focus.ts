"use client";

import { useEffect, type RefObject } from "react";
import type { FocusRequest } from "../../lib/chat/composer-focus";
import {
  LAYER_CLOSE_WAIT_MS,
  PENDING_REQUEST_MS,
  autoFocusComposer,
  coarsePointer,
  focusRequest,
  focusVerdict,
} from "../../lib/chat/composer-focus";

/** The page's first focus request (its load) has happened: later ones are thread switches. */
let loadHandled = false;

/**
 * A request still waiting for the composer to mount (a slow thread) when the component that made
 * it unmounted: the next composer to mount takes it over, until `PENDING_REQUEST_MS` after it was
 * made. Cleared once used, or when the member moves the focus, presses a key or opens a layer.
 */
let pending: { readonly request: FocusRequest; readonly started: number } | null = null;

/** Tests start each case as a fresh page load. */
export function resetComposerFocusForTests(): void {
  loadHandled = false;
  pending = null;
}

/**
 * Moves the focus to the composer when `threadKey` comes on screen (KOBE-840): the page's load,
 * New chat (a new draft's key) and another conversation chosen from the Threads panel, the palette
 * or a search hit. Two frames later, as `focusComposerSoon` does, so the thread's content and the
 * layer it was chosen in have settled; while a dialog or menu is still open it waits for that to
 * close, up to `LAYER_CLOSE_WAIT_MS`; while the message box is not mounted yet (a slow thread) the
 * request stays pending, also across a remount, up to `PENDING_REQUEST_MS`. It never takes the focus from another field, never over a
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
    // A request left pending by a composer that unmounted before its message box came is kept.
    const carried = pending !== null && performance.now() - pending.started < PENDING_REQUEST_MS;
    const { request, started } = carried
      ? (pending as NonNullable<typeof pending>)
      : { request: focusRequest(document, atLoad), started: performance.now() };
    pending = null;
    let frame = 0;
    let open = true;
    const finish = () => {
      open = false;
      pending = null;
      cancelAnimationFrame(frame);
    };
    const attempt = () => {
      const composer = input.current;
      const verdict = focusVerdict(document, composer, request);
      const age = performance.now() - started;
      if (verdict === "focus" && composer !== null) {
        autoFocusComposer(composer);
        open = false;
      } else if (verdict === "wait" && age < LAYER_CLOSE_WAIT_MS) {
        frame = requestAnimationFrame(attempt);
      } else if (verdict === "missing" && age < PENDING_REQUEST_MS) {
        frame = requestAnimationFrame(attempt);
      } else open = false;
    };
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(attempt);
    });
    // A key or a press after the request is the member's own next step: the request ends.
    document.addEventListener("keydown", finish, true);
    document.addEventListener("pointerdown", finish, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", finish, true);
      document.removeEventListener("pointerdown", finish, true);
      // Unmounted (or another thread) before the message box came: the request stays pending.
      if (open && input.current === null) pending = { request, started };
    };
  }, [input, threadKey, enabled]);
}
