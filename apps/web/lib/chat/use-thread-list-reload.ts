/**
 * Reads the thread list again whenever the session says it changed (KOBE-716: the four identical
 * subscriptions of `ChatWorkspace` in one hook). Not the cross-tab channel (`thread-list-sync.ts`):
 * that one feeds `onThreadListChanged`, one of the sources here.
 */
import { useEffect } from "react";
import type { ChatSession } from "./session";

export function useThreadListReload(
  session: ChatSession,
  runtime: { readonly threads: { readonly reload: () => unknown } },
): void {
  useEffect(() => {
    const reload = () => void runtime.threads.reload();
    const stops = [
      // A thread created by its first message: read the list again for its title.
      session.onThreadCreated(reload),
      // The server titled a thread after its first answer (KOBE-219).
      session.onThreadRetitled(reload),
      // Pinned, archived or moved, in this tab or another one (CE19, KOBE-220).
      session.onThreadListChanged(reload),
      // Another folder chosen in the Threads panel (KOBE-536): the list reads that folder's threads.
      session.panelMemory.onFolderChange(reload),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [session, runtime]);
}
