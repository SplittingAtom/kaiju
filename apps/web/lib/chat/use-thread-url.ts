/**
 * The thread on screen in the address (`?thread=<id>`, KOBE-452): read, followed and opened from
 * outside the workspace (KOBE-716: out of `components/chat/chat-app.tsx`).
 */
import { useCallback, useEffect, useState } from "react";
import { onChatPage } from "../shell/areas";
import { lastThreadId } from "../shell/last-thread";

const THREAD_PARAM = "thread";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function threadFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get(THREAD_PARAM) ?? "";
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

/**
 * `?thread=<id>` follows the thread on screen, so a link or a refresh reopens it. Under a panel
 * (KOBE-452) the address is the panel's: the workspace keeps its thread (opened by a link or a
 * reload, the one last on screen in this tab), and follows the address again once the chat is.
 */
export function useThreadUrl(
  teamId: string,
  pathname: string,
): readonly [string | undefined, (id: string | undefined) => void] {
  const [threadId, setThreadId] = useState<string | undefined>(() =>
    onChatPage() ? threadFromUrl() : lastThreadId(teamId),
  );
  useEffect(() => {
    const onPop = () => {
      if (onChatPage()) setThreadId(threadFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Back on the chat from a panel (Close, or a link to a thread): its address names the thread.
  useEffect(() => {
    if (pathname === "/" && onChatPage()) setThreadId(threadFromUrl());
  }, [pathname]);
  const change = useCallback((id: string | undefined) => {
    setThreadId(id);
    // Under a panel the thread changes without touching its address (Close returns to it).
    if (!onChatPage() || threadFromUrl() === id) return;
    const url = new URL(window.location.href);
    if (id === undefined) url.searchParams.delete(THREAD_PARAM);
    else url.searchParams.set(THREAD_PARAM, id);
    window.history.pushState(null, "", url);
  }, []);
  return [threadId, change];
}

/** Opens a thread from outside the workspace (the bell in the bar): `useThreadUrl` follows. */
export function openThreadInChat(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(THREAD_PARAM, id);
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
