/**
 * The workspace's route (KOBE-452): the router's, or the address itself when the chat renders
 * alone (KOBE-716: out of `components/chat/chat-app.tsx`).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * How the workspace moves between the chat and its panels (KOBE-452): the router's address and
 * page, from the root layout (components/shell/workspace-host.tsx). Without one (tests of the chat
 * alone) the chat is all there is.
 */
export interface WorkspaceRoute {
  readonly pathname: string;
  /** The route's page: shown in the panel when `pathname` names one. */
  readonly page: ReactNode;
  readonly push: (href: string) => void;
  readonly replace: (href: string) => void;
}

/**
 * Without the router (the chat rendered alone, in tests), the address itself: `history` moves it
 * and Back and Forward follow, so the panels that live in the workspace (Threads, KOBE-453) open
 * and close as they do under Next.
 */
export function useHistoryRoute(route: WorkspaceRoute | undefined): WorkspaceRoute {
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  useEffect(() => {
    if (route) return;
    const follow = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, [route]);
  const own = useMemo<WorkspaceRoute>(() => {
    const go = (href: string, replace: boolean) => {
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
      setPathname(window.location.pathname);
    };
    return {
      pathname,
      page: null,
      push: (href) => go(href, false),
      replace: (href) => go(href, true),
    };
  }, [pathname]);
  return route ?? own;
}
