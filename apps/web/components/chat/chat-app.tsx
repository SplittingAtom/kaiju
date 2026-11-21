"use client";

import "../../lib/security/zod-jitless";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { TeamInvites } from "../../app/team-invites";
import { TeamActivation } from "../../app/team-switcher";
import { createChatApi } from "../../lib/chat/api";
import { browserThreadListSync, type ThreadListSync } from "../../lib/chat/thread-list-sync";
import { ChatSession } from "../../lib/chat/session";
import type { EventSourceFactory } from "../../lib/chat/stream";
import type { UploadTransport } from "../../lib/chat/uploads";
import { useActiveTeam } from "../../lib/chat/use-active-team";
import { useHistoryRoute, type WorkspaceRoute } from "../../lib/chat/use-history-route";
import { openThreadInChat } from "../../lib/chat/use-thread-url";
import { onChatPage } from "../../lib/shell/areas";
import { lastThreadHref } from "../../lib/shell/last-thread";
import { followWorkspaceEntries, stepsBackToWorkspace } from "../../lib/shell/panel-history";
import { panelOfPath } from "../../lib/shell/panels";
import { LayoutPreferencesContext, useLayoutPreferences } from "../../lib/shell/preferences";
import { FrameDragGhost } from "../apps/frame-drag-ghost";
import { IconActionProvider } from "../shell/icon-action";
import { OpenPanelContext } from "../shell/panel-close";
import { ShellBandProvider } from "../shell/shell-band";
import { ShellSlotsProvider } from "../shell/shell-slots";
import { InlineLink } from "../shell/text-links";
import { UtilityBar } from "../shell/utility-bar";
import { WorkspacePanel } from "../shell/workspace-panel";
import { ChatWorkspace } from "./chat-workspace";
import { ChatSessionContext } from "./kobe-runtime";
import { useViewportHeight } from "./use-viewport-height";
import styles from "./chat.module.css";

export type { WorkspaceRoute } from "../../lib/chat/use-history-route";

export interface ChatAppProps {
  /** Tests inject the API transport and the event stream. */
  readonly fetchFn?: typeof fetch | undefined;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly reopenDelayMs?: ((attempt: number) => number) | undefined;
  readonly uploadTransport?: UploadTransport | undefined;
  /** This browser's other tabs (CE19); default: a `BroadcastChannel` per team. */
  readonly threadListSync?: ((teamId: string) => ThreadListSync | undefined) | undefined;
  /** How often the rail rereads an active thread's state (KOBE-301); tests shorten it. */
  readonly activityPollMs?: number | undefined;
  /** The router's address and page: a panel over the workspace (KOBE-452). */
  readonly route?: WorkspaceRoute | undefined;
}

/**
 * The chat app (KOBE-32; v1.1 shell KOBE-197): the two-row utility bar on top, then the rail,
 * artifact column and conversation. Everything goes through the server's APIs with the session
 * cookie from this browser; nothing is fetched or cached on the Next.js server.
 */
export function ChatApp({
  fetchFn,
  eventSource,
  newKey,
  reopenDelayMs,
  uploadTransport,
  threadListSync = browserThreadListSync,
  activityPollMs,
  route: givenRoute,
}: ChatAppProps) {
  const route = useHistoryRoute(givenRoute);
  const team = useActiveTeam(fetchFn);
  const teamId = team.status === "ready" ? team.teamId : null;
  const session = useMemo(
    () =>
      teamId === null
        ? null
        : new ChatSession({
            teamId,
            api: createChatApi(teamId, fetchFn),
            eventSource,
            newKey,
            reopenDelayMs,
            uploadTransport,
            fetchFn,
            listSync: threadListSync(teamId),
          }),
    [teamId, fetchFn, eventSource, newKey, reopenDelayMs, uploadTransport, threadListSync],
  );
  useEffect(() => () => session?.dispose(), [session]);
  // The member's layout (CE8), for the workspace and the panel page over it (KOBE-459).
  const layout = useLayoutPreferences(fetchFn, session !== null);
  const [appEl, setAppEl] = useState<HTMLDivElement | null>(null);
  useViewportHeight(appEl);
  const { pathname } = route;
  const panel = panelOfPath(pathname);
  // The chat entry a panel returns to (KOBE-452): the latest one shown without a panel.
  useEffect(() => followWorkspaceEntries(onChatPage), []);
  const closePanel = useCallback(() => {
    const steps = stepsBackToWorkspace();
    if (steps !== null) window.history.go(steps);
    else route.replace(lastThreadHref(teamId));
  }, [route, teamId]);
  // The bell under a panel: the thread opens in the chat, and the panel closes.
  const openThreadFromHeader = useCallback(
    (id: string) => {
      if (panel !== undefined) route.push(`/?thread=${id}`);
      else openThreadInChat(id);
    },
    [panel, route],
  );

  let body: ReactNode;
  if (team.status === "loading" || team.status === "choosing")
    body = (
      <p className={styles.empty} role="status">
        {team.status === "choosing" ? "Choosing your team…" : "Loading…"}
      </p>
    );
  else if (team.status === "signedOut") {
    body = (
      <p className={styles.empty}>
        <InlineLink href="/sign-in">Sign in</InlineLink> to chat with your agents.
      </p>
    );
  } else if (team.status === "noTeam") {
    body = (
      <p className={styles.empty}>You are not in any team yet. Ask an admin to add you to one.</p>
    );
  } else if (team.status === "error") {
    body = (
      <p className={styles.empty} role="alert">
        {team.message}
      </p>
    );
  } else if (session) {
    body = (
      <ChatSessionContext.Provider value={session}>
        {/* The ghost chip of a pointer drag out of an app frame (KOBE-553). */}
        <FrameDragGhost />
        <ChatWorkspace
          key={session.teamId}
          session={session}
          teamName={team.status === "ready" ? team.teamName : ""}
          fetchFn={fetchFn}
          activityPollMs={activityPollMs}
          pathname={pathname}
          replace={route.replace}
          onClosePanel={closePanel}
          layout={layout}
        />
      </ChatSessionContext.Provider>
    );
  }

  return (
    <LayoutPreferencesContext value={layout}>
      <OpenPanelContext.Provider value={route.push}>
        <IconActionProvider>
          <ShellBandProvider>
            <ShellSlotsProvider>
              <div ref={setAppEl} className={styles.app} data-kobe-chat>
                {/* eslint-disable-next-line no-restricted-syntax -- a skip link is text by design (WCAG 2.4.1) */}
                <a className={styles.skipLink} href="#kobe-chat-main">
                  Skip to the conversation
                </a>
                <UtilityBar teamId={teamId} fetchFn={fetchFn} onOpenThread={openThreadFromHeader} />
                <TeamInvites />
                {/* No active team yet: activates one (the selector itself is in the rail, KOBE-419). */}
                <TeamActivation />
                {body}
                {/* A console, Agents, Skills or a My area page over the workspace (KOBE-452). */}
                {panel !== undefined &&
                panel.id !== "threads" &&
                panel.id !== "conversation-tree" ? (
                  <WorkspacePanel panel={panel} path={pathname} onClose={closePanel}>
                    {route.page}
                  </WorkspacePanel>
                ) : (
                  route.page
                )}
              </div>
            </ShellSlotsProvider>
          </ShellBandProvider>
        </IconActionProvider>
      </OpenPanelContext.Provider>
    </LayoutPreferencesContext>
  );
}
