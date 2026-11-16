/**
 * Asks the conversation on screen to scroll to an entry and flash it (KOBE-396: To review's
 * evidence quotes). The thread view of `threadId` answers when it shows that thread; an entry off
 * the current branch is not shown (the request is dropped).
 */
export interface RevealRequest {
  readonly threadId: string;
  readonly entryId: string;
}

export const REVEAL_REQUEST_EVENT = "kobe:reveal-entry";

export function requestReveal(request: RevealRequest): void {
  window.dispatchEvent(new CustomEvent<RevealRequest>(REVEAL_REQUEST_EVENT, { detail: request }));
}

/** Calls `reveal` for requests about `threadId`; returns the unsubscribe. */
export function onRevealRequest(
  threadId: string | undefined,
  reveal: (entryId: string) => void,
): () => void {
  const on = (e: Event) => {
    const r = (e as CustomEvent<RevealRequest>).detail;
    if (threadId !== undefined && r.threadId === threadId) reveal(r.entryId);
  };
  window.addEventListener(REVEAL_REQUEST_EVENT, on);
  return () => window.removeEventListener(REVEAL_REQUEST_EVENT, on);
}
