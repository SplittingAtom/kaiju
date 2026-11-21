"use client";

/**
 * The chat workspace of one team (KOBE-716: out of `chat-app.tsx`): the thread on screen, its
 * runtime and the providers, rail, conversation and panels around it.
 */
import { AssistantRuntimeProvider, Suggestions, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { ChatSession } from "../../lib/chat/session";
import { createThreadListAdapter } from "../../lib/chat/thread-list-adapter";
import { useThreadListReload } from "../../lib/chat/use-thread-list-reload";
import { threadFromUrl, useThreadUrl, UUID } from "../../lib/chat/use-thread-url";
import { createFilesApi } from "../../lib/files/api";
import { createReviewApi } from "../../lib/memory/review-api";
import { AREAS, areaFromUrl, onChatPage } from "../../lib/shell/areas";
import { rememberLastThread } from "../../lib/shell/last-thread";
import { panelOfPath, TREE_PANEL_HREF, type Panel } from "../../lib/shell/panels";
import type { LayoutPreferencesApi } from "../../lib/shell/preferences";
import { ThreadAppsProvider } from "../apps/thread-apps";
import { FileGoneNotice } from "../files/file-tab";
import { useReviewArrival } from "../memory/review/arrival";
import { WorkspaceProjectsProvider } from "../projects/workspace-projects";
import { AppCommands } from "../shell/app-commands";
import { CommandBindingsProvider } from "../shell/command-bindings";
import { CommandPalette } from "../shell/command-palette";
import { ContextViewerHost } from "../shell/context-viewer";
import { useOpenPanel } from "../shell/panel-close";
import { RailDrawerButton, RailProvider, useRail } from "../shell/rail-state";
import { ShellGrid } from "../shell/shell-grid";
import { ShellSlot, useBarMenu } from "../shell/shell-slots";
import { ShortcutKeys } from "../shell/shortcut-keys";
import { ShortcutSheet } from "../shell/shortcut-sheet";
import { ThreadGroupsProvider } from "../shell/thread-groups";
import { ThreadSearch } from "../shell/thread-search";
import { ThreadsPanelContent } from "../shell/threads-panel";
import { WorkspacePanel } from "../shell/workspace-panel";
import { WorkspaceRail } from "../shell/workspace-rail";
import { ThreadBlockedProvider } from "./answer-blocked";
import { AnswerFeedbackProvider } from "./answer-feedback";
import { ArtifactPanel } from "./artifact-panel";
import { ArtifactPanelProvider, useArtifactPanel } from "./artifact-state";
import { DetailProvider } from "./detail";
import { useKobeRuntime } from "./kobe-runtime";
import { ThreadMarkersProvider } from "./markers";
import { ThreadUsageProvider } from "./message-footer";
import { RetentionNotice } from "./retention-notice";
import { SavedSkillNotice } from "./saved-skill-notice";
import { ThreadActivityWatch } from "./thread-activity";
import { ThreadOnScreenContext } from "./thread-on-screen";
import { ThreadView } from "./thread-view";
import { TreeHost, type TreeRoute } from "./tree-host";
import { TeamModelsProvider } from "./use-team-models";
import styles from "./chat.module.css";

/** The shell grid with the rail's and the artifact column's dragged widths (CE6) and sheet (CE7). */
function WorkspaceGrid(
  props: Omit<
    Parameters<typeof ShellGrid>[0],
    "artifactWidth" | "railWidth" | "artifactSheet" | "artifactHidden"
  >,
) {
  const panel = useArtifactPanel();
  const rail = useRail();
  return (
    <ShellGrid
      {...props}
      artifactWidth={panel?.width ?? null}
      railWidth={rail?.shownWidth ?? null}
      artifactSheet={panel?.sheetOpen ?? false}
      artifactHidden={panel?.hidden ?? false}
    />
  );
}

/** Starter prompts on an empty conversation; picking one fills the composer. */
const STARTER_SUGGESTIONS = [
  {
    title: "Analyse a spreadsheet",
    label: "and chart the result",
    prompt: "Analyse the CSV in my files and chart the most important trend.",
  },
  {
    title: "Write a script",
    label: "and run it in the sandbox",
    prompt: "Write a Python script that renames my files by date, and run it.",
  },
  {
    title: "Summarise my files",
    label: "what is in it?",
    prompt: "List my files and summarise what each one is for.",
  },
];

export function ChatWorkspace({
  session,
  teamName,
  fetchFn,
  activityPollMs,
  pathname,
  replace,
  onClosePanel,
  layout,
}: {
  readonly session: ChatSession;
  /** The member's layout, from any device (CE8): loaded once by ChatApp, saved debounced. */
  readonly layout: LayoutPreferencesApi;
  /** The address (KOBE-452): the chat, or a panel over it. */
  readonly pathname: string;
  readonly replace: ((href: string) => void) | undefined;
  /** Closes the panel open over the workspace (the Threads panel renders in here). */
  readonly onClosePanel: () => void;
  readonly activityPollMs: number | undefined;
  /** The rail's header (CE2): the workspace is the member's view of this team. */
  readonly teamName: string;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const filesApi = useMemo(() => createFilesApi(session.teamId, fetchFn), [session, fetchFn]);
  const [threadId, setThreadId] = useThreadUrl(session.teamId, pathname);
  // The panels return here, to this thread (CE4, KOBE-452).
  useEffect(() => rememberLastThread(session.teamId, threadId), [session, threadId]);
  // The thread on screen is seen: never "new activity" (KOBE-453, the Threads button's dot).
  useEffect(() => session.activity.setOnScreen(threadId ?? null), [session, threadId]);
  // A link from before KOBE-452 (`/?thread=…&area=memory`) opens that page's panel over the thread.
  useEffect(() => {
    const area = onChatPage() ? areaFromUrl() : undefined;
    if (area === undefined || replace === undefined) return;
    rememberLastThread(session.teamId, threadFromUrl());
    replace(AREAS[area].href);
    // Read once: the address of the first render.
  }, [session]);
  // The one-row bar's Menu closes once another thread is on screen (a search hit, the bell).
  const { setOpen: setBarMenuOpen } = useBarMenu();
  useEffect(() => setBarMenuOpen(false), [threadId, setBarMenuOpen]);
  const [listError, setListError] = useState<ApiError | null>(null);
  const adapter = useMemo(
    () => createThreadListAdapter(session, { onError: setListError }),
    [session],
  );
  // `/?project=<id>` starts the next new conversation inside that project (KOBE-164): on the first
  // load and whenever a link brings the chat back with one (a project page's Open to mount or Open
  // in a conversation is a client-side link from a panel, so this component stays mounted and the
  // address returns to `/`, which opens a new conversation). Handled once: the parameter is dropped
  // from the address, so the draft does not follow later threads and a reload starts nothing.
  useEffect(() => {
    if (pathname !== "/") return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get("project") ?? "";
    if (!UUID.test(id)) return;
    if (threadFromUrl() === undefined) session.setDraftProject(id.toLowerCase());
    url.searchParams.delete("project");
    window.history.replaceState(window.history.state, "", url);
  }, [session, pathname]);
  // NC4: New conversation and opening another conversation end the draft's project (a new draft
  // starts without one); switching workspace builds a new session, which starts without one too.
  const changeThread = useCallback(
    (next: string | undefined) => {
      session.setDraftProject(null);
      setThreadId(next);
    },
    [session, setThreadId],
  );
  const runtime = useKobeRuntime({
    session,
    adapter,
    threadId,
    onThreadIdChange: changeThread,
  });
  // Created, retitled, pinned, archived, moved, another folder: the rail reads the list again.
  useThreadListReload(session, runtime);
  const aui = useAui({ suggestions: Suggestions(STARTER_SUGGESTIONS) });
  const panel = panelOfPath(pathname);
  const threadsPanel: Panel | undefined = panel?.id === "threads" ? panel : undefined;
  // A thread chosen in the Threads panel is on screen (assistant-ui switched to it): the panel's
  // entry becomes that thread's, so Back returns to the conversation before it.
  const chooseThread = useCallback(
    (id: string) => {
      if (replace !== undefined) replace(`/?thread=${id}`);
      else onClosePanel();
    },
    [replace, onClosePanel],
  );
  // Another thread on screen while the Threads panel is open (its title, Regenerate, Make a skill
  // from this): the panel closes onto it.
  const shownAtOpen = useRef<string | undefined>(undefined);
  const threadsOpen = threadsPanel !== undefined;
  useEffect(() => {
    if (!threadsOpen) return;
    shownAtOpen.current = threadId;
    // Only the thread on screen when the panel opened: later switches are below.
  }, [threadsOpen]);
  useEffect(() => {
    if (threadsOpen && threadId !== undefined && threadId !== shownAtOpen.current) {
      chooseThread(threadId);
    }
  }, [threadsOpen, threadId, chooseThread]);
  // The Conversation tree (CT4, KOBE-546) at `/tree`: a link, a reload and Back work.
  const push = useOpenPanel();
  const treeOpen = panel?.id === "conversation-tree";
  const treeRoute = useMemo<TreeRoute>(
    () => ({
      open: treeOpen,
      show: () => push?.(TREE_PANEL_HREF),
      close: onClosePanel,
    }),
    [treeOpen, push, onClosePanel],
  );
  // A finished learning pass opens To review when the person is here and nothing else is open
  // (KOBE-396); otherwise its candidates wait in the bell and on +.
  useReviewArrival({
    threadId,
    panelOpen: panel !== undefined,
    open: (href) => push?.(href),
    seen: (id) => void createReviewApi(session.teamId, fetchFn).seen(id),
  });
  // A fork opened from the tree: the panel's entry becomes that thread's, as in Threads.
  const openFromTree = useCallback(
    (id: string) => {
      setThreadId(id);
      chooseThread(id);
    },
    [setThreadId, chooseThread],
  );
  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      {/* What each action does now: the `/` menu (KOBE-224), the palette and keys (KOBE-225). */}
      <CommandBindingsProvider>
        <RetentionNotice />
        <SavedSkillNotice />
        <ThreadGroupsProvider fetchFn={fetchFn}>
          <WorkspaceProjectsProvider teamId={session.teamId} fetchFn={fetchFn}>
            <ThreadOnScreenContext value={threadId ?? null}>
              <RailProvider preferences={layout.preferences} onSave={layout.save}>
                <DetailProvider preferences={layout.preferences} onSave={layout.save}>
                  <ThreadUsageProvider>
                    <ThreadBlockedProvider>
                      <AnswerFeedbackProvider>
                        <TeamModelsProvider>
                          <ThreadMarkersProvider>
                            <ThreadAppsProvider>
                              <ArtifactPanelProvider
                                teamId={session.teamId}
                                threadId={threadId}
                                preferences={layout.preferences}
                                onSavePreferences={layout.save}
                              >
                                <FileGoneNotice />
                                {/* The rail's run and approval dots stay current; the tab title (KOBE-301). */}
                                <ThreadActivityWatch pollMs={activityPollMs} />
                                <AppCommands />
                                {/* CE23 (KOBE-225): the keys, the palette and the `?` sheet run the bindings. */}
                                <ShortcutKeys />
                                <CommandPalette onOpenThread={setThreadId} />
                                <ShortcutSheet />
                                <ShellSlot name="search">
                                  <ThreadSearch onOpenThread={setThreadId} />
                                </ShellSlot>
                                <ShellSlot name="nav">
                                  <RailDrawerButton teamName={teamName} />
                                </ShellSlot>
                                <TreeHost route={treeRoute} onOpenThread={openFromTree}>
                                  <ContextViewerHost>
                                    <WorkspaceGrid
                                      rail={
                                        <WorkspaceRail
                                          teamName={teamName || "Workspace"}
                                          listError={listError}
                                          filesApi={filesApi}
                                        />
                                      }
                                      artifact={<ArtifactPanel filesApi={filesApi} />}
                                      conversation={
                                        <main
                                          id="kobe-chat-main"
                                          className={styles.main}
                                          tabIndex={-1}
                                        >
                                          <ThreadView onOpenThread={setThreadId} inShell />
                                        </main>
                                      }
                                    />
                                  </ContextViewerHost>
                                </TreeHost>
                                {/* The Threads panel (KOBE-453) needs the thread list: it renders in here. */}
                                {threadsPanel !== undefined && (
                                  <WorkspacePanel
                                    panel={threadsPanel}
                                    path={pathname}
                                    onClose={onClosePanel}
                                  >
                                    <ThreadsPanelContent
                                      listError={listError}
                                      onChosen={chooseThread}
                                      filesApi={filesApi}
                                      workspaceName={teamName}
                                      onClose={onClosePanel}
                                    />
                                  </WorkspacePanel>
                                )}
                              </ArtifactPanelProvider>
                            </ThreadAppsProvider>
                          </ThreadMarkersProvider>
                        </TeamModelsProvider>
                      </AnswerFeedbackProvider>
                    </ThreadBlockedProvider>
                  </ThreadUsageProvider>
                </DetailProvider>
              </RailProvider>
            </ThreadOnScreenContext>
          </WorkspaceProjectsProvider>
        </ThreadGroupsProvider>
      </CommandBindingsProvider>
    </AssistantRuntimeProvider>
  );
}
