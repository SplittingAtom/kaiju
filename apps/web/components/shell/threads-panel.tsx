"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { folderPath, placeFolders, treeRows, type PanelNode } from "../../lib/chat/folder-tree";
import { foldersOf } from "../../lib/chat/folders-store";
import { organizedMessage } from "../../lib/chat/organize";
import { placementOf, type ThreadGroup } from "../../lib/chat/thread-groups";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession } from "../chat/kaiju-runtime";
import { filedMessage } from "../chat/save-to-folder-menu";
import { RailAnnounce } from "../chat/use-organize-menu";
import { useFolderReads, useThreadFolders } from "../chat/use-thread-folders";
import { useFolderActions } from "./folder-node-menu";
import { FileMapLayer } from "./file-map-layer";
import {
  FileRailResizeHandle,
  railStyle,
  THREE_RAIL_COLUMNS,
  useFileRailWidth,
} from "./file-rail-resize";
import { useShellBand } from "./shell-band";
import { ThreadFileMap } from "./thread-file-row";
import { useShownThreads, useThreadLinks } from "./use-file-links";
import { NodeList } from "./thread-node-list";
import { useThreadGroups } from "./thread-groups";
import { SearchHits, useThreadsSearch } from "./threads-search";
import chat from "../chat/chat.module.css";
import { FolderColumn, threadPlaces, ThreadsSearchBar } from "./threads-panel-parts";
import { useThreadFileMapValue } from "./use-thread-file-map";

/** The panel's tree state: the folders placed, the counts, the chosen node and its memory. */
function useTreeModel() {
  const session = useChatSession();
  const memory = session.panelMemory;
  useSyncExternalStore(memory.subscribe, memory.getVersion, memory.getVersion);
  const folders = useThreadFolders();
  const list = foldersOf(folders);
  const { listed, trashIds } = useThreadGroups();
  const placed = useMemo(() => placeFolders(list), [list]);
  const counts = useMemo(() => {
    let current = 0;
    let archived = 0;
    for (const t of listed) {
      const p = placementOf(t.custom);
      if (p.archived) archived += 1;
      else if (p.folderId === null) current += 1;
    }
    return { current, archived, deleted: trashIds.length };
  }, [listed, trashIds]);
  const rows = treeRows(placed, counts, {
    currentOpen: memory.currentOpen,
    open: memory.openFolders,
  });
  // A chosen folder another member deleted: the panel falls back to Current.
  const node = memory.node;
  const gone =
    node.kind === "folder" && folders.status === "ready" && !list.some((f) => f.id === node.id);
  useEffect(() => {
    if (gone) memory.choose({ kind: "current" });
  }, [gone, memory]);
  return { memory, node, list, placed, counts, rows };
}

/**
 * The Threads panel's content (KOBE-453, CE5; two rails since KOBE-536, TF7; three since KOBE-612,
 * spec thread-file-map): the server's search and Export above; on wide windows (1,100 px and
 * wider) the folder tree, the chosen node's threads and a read-only workspace rail, with lines
 * between threads and the files they used; at 820 px and wider the tree beside the threads; below
 * that a dropdown above them. Rows keep the rail's menu, keyboard access and drag onto a project
 * header or a folder; a row with links has its line pin and "Files (N)…" in its ⋯ menu (KOBE-614).
 * At three rails the thread column is as wide as its titles, the workspace rail takes the rest
 * (or its dragged width) and each column scrolls on its own. Choosing a thread (its title) calls
 * `onChosen`: the panel closes onto it; a file opens in the artifact column and `onClose` closes
 * the panel.
 */
export function ThreadsPanelContent({
  listError,
  onChosen,
  filesApi,
  workspaceName = "",
  onClose,
}: {
  readonly listError: ApiError | null;
  onChosen(threadId: string): void;
  /** The workspace's files: the third rail at wide widths. Absent: two rails at most. */
  readonly filesApi?: FilesApi | undefined;
  readonly workspaceName?: string | undefined;
  /** Closes the panel (after a file opened in the artifact column). */
  readonly onClose?: (() => void) | undefined;
}) {
  const session = useChatSession();
  const artifactPanel = useArtifactPanel();
  const items = useAuiState((s) => s.threads.threadItems);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const loading = useAuiState((s) => s.threads.isLoading);
  const { groups, projects, listed, trashIds } = useThreadGroups();
  const band = useShellBand();
  const wide = band === "wide" || band === "medium";
  // Three rails only where they fit (TFM4: about 1,100 px): the shell's wide band.
  const threeRails = band === "wide" && filesApi !== undefined;
  useFolderReads();
  const tree = useTreeModel();
  const { memory, node, list, placed } = tree;
  const [query, setQuery] = useState("");
  // One polite region for the rows' changes: a row that moves to another group is remounted.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const actions = useFolderActions(placed, announce);
  const titleOf = (threadId: string) =>
    items.find((i) => i.remoteId === threadId)?.title || "Untitled conversation";
  const search = useThreadsSearch(query);
  const searching = query.trim() !== "";

  // Thread–file links (KOBE-612): read for the rows on screen before any hover.
  const bodyRef = useRef<HTMLDivElement>(null);
  const threadsRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const shownIds = useShownThreads(threadsRef);
  const shownThreads = useMemo(() => new Set(shownIds), [shownIds]);
  const links = useThreadLinks(session.api, shownIds);
  const railWidth = useFileRailWidth();
  const openPanelFile = artifactPanel?.openFile;
  const { pins, fileMap } = useThreadFileMapValue(threeRails, links, openPanelFile, onClose);

  const moveByDrop = (threadId: string, projectId: string) => {
    const change = { action: "move", projectId } as const;
    const title = titleOf(threadId);
    void session.organize(threadId, change).then((res) => {
      if (res.ok) announce(organizedMessage(change, title, projects.names.get(projectId)));
      else
        announce(
          res.error.code === "project_not_found"
            ? "You can't start conversations in that project, so this one can't move there."
            : res.error.message,
        );
    });
  };
  const fileByDrop = (threadId: string, folderId: string | null) => {
    const title = titleOf(threadId);
    const from = items.find((i) => i.remoteId === threadId);
    const before = from ? placementOf(from.custom).folderId : null;
    if (before === folderId) return;
    void session.file(threadId, folderId).then((res) => {
      const name = folderId === null ? null : (list.find((f) => f.id === folderId)?.name ?? null);
      announce(
        res.ok
          ? filedMessage(title, name, folderPath(list, before) ?? undefined)
          : res.error.message,
      );
    });
  };
  const choose = (next: PanelNode) => {
    memory.choose(next);
    setQuery("");
  };
  const setOpen = (target: PanelNode, open: boolean) => {
    if (target.kind === "current") memory.setCurrentOpen(open);
    else if (target.kind === "folder") memory.setFolderOpen(target.id, open);
  };

  // A thread's title opens it: once assistant-ui has switched, the panel closes onto it.
  const chooseOnClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element) || e.defaultPrevented) return;
    if (e.target.closest(`.${chat.threadTrigger}`) === null) return;
    const threadId = e.target.closest("[data-kaiju-thread]")?.getAttribute("data-kaiju-thread");
    if (threadId) queueMicrotask(() => onChosen(threadId));
  };

  const { archived, archivedNotes, placeOf } = threadPlaces(listed, items, list, trashIds);
  const chosenPlaced =
    node.kind === "folder" ? placed.find((p) => p.folder.id === node.id) : undefined;
  // "Used in" (KOBE-612): the panel closes onto the thread, as for a search hit not yet listed.
  const openThread = (threadId: string) => onChosen(threadId);

  return (
    <RailAnnounce.Provider value={announce}>
      <ThreadFileMap.Provider value={fileMap}>
        <ThreadListPrimitive.Root
          className={`flex flex-col gap-2 px-4 py-3 ${threeRails ? "h-full min-h-0" : "min-h-full"}`}
        >
          <ThreadsSearchBar query={query} setQuery={setQuery} teamId={session.teamId} />
          <div
            ref={bodyRef}
            style={threeRails ? railStyle(railWidth.width) : undefined}
            className={
              threeRails
                ? `relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 ${THREE_RAIL_COLUMNS}`
                : wide
                  ? "grid min-w-0 grid-cols-[220px_1px_minmax(0,1fr)] gap-3"
                  : "flex flex-col gap-2"
            }
            data-kaiju-threads-body={threeRails ? "three-rails" : wide ? "two-rails" : "dropdown"}
          >
            <FolderColumn
              wide={wide}
              threeRails={threeRails}
              rows={tree.rows}
              counts={tree.counts}
              node={node}
              placed={placed}
              chosenPlaced={chosenPlaced}
              actions={actions}
              announce={announce}
              choose={choose}
              setOpen={setOpen}
              fileByDrop={fileByDrop}
            />
            {wide && <div aria-hidden className="bg-border w-px self-stretch" />}
            {/* Sees the clicks of the rows' own title buttons (Enter on a button is one). */}
            <div
              ref={threadsRef}
              className={threeRails ? "min-h-0 min-w-48 overflow-y-auto" : "min-w-0"}
              data-kaiju-thread-column=""
              onClick={chooseOnClick}
            >
              {listError && <ErrorNotice error={listError} />}
              {projects.failed && (
                <p className={chat.hint} role="status">
                  Project names could not be loaded.
                </p>
              )}
              {searching ? (
                <SearchHits state={search.state} more={search.more} folders={list} />
              ) : (
                <NodeList
                  node={node}
                  groups={groups}
                  archived={archived}
                  archivedNotes={archivedNotes}
                  trash={trashIds.map((id, index) => ({ id, index }))}
                  loading={loading}
                  hasMore={hasMore && (node.kind === "current" || node.kind === "folder")}
                  hasSubfolders={(chosenPlaced?.childCount ?? 0) > 0}
                  isOpen={(g: ThreadGroup) => !memory.flipped(g.key)}
                  onToggle={(g: ThreadGroup) => memory.flip(g.key)}
                  onMove={moveByDrop}
                />
              )}
              <p role="status" className="sr-only" data-kaiju-rail-status="">
                {announcement}
              </p>
            </div>
            {threeRails && filesApi && (
              <FileRailResizeHandle
                width={railWidth.width}
                onChange={railWidth.setWidth}
                onReset={railWidth.resetWidth}
              />
            )}
            {threeRails && filesApi && (
              <FileMapLayer
                filesApi={filesApi}
                linksApi={session.api}
                workspaceName={workspaceName}
                links={links}
                shownThreads={shownThreads}
                pins={pins}
                map={fileMap}
                bodyRef={bodyRef}
                threadsRef={threadsRef}
                railRef={railRef}
                titleOf={titleOf}
                placeOf={placeOf}
                openThread={openThread}
              />
            )}
          </div>
        </ThreadListPrimitive.Root>
      </ThreadFileMap.Provider>
    </RailAnnounce.Provider>
  );
}
