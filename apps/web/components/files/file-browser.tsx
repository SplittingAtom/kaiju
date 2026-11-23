"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { expandedKey, splitProjectRows } from "../../lib/files/tree";
import { ErrorNotice } from "../admin/error-notice";
import { FileTreeView } from "./file-tree";
import { useFileTree } from "./use-file-tree";
import type { FileLinksApi } from "../../lib/threads/file-links";
import { useFileThreads } from "../shell/use-file-links";
import { useProjectHeads } from "./project-heads";
import {
  NoProjects,
  ProjectsFilter,
  ProjectsHeader,
  ShowAllProjects,
  useProjectsInTree,
  WorkspaceHeader,
} from "./workspace-tree";
import { ProjectWorkPanel, type ProjectRef, type WorkAction } from "../projects/project-work";
import { createProjectsApi } from "../../lib/projects/api";
import { useWorkspaceProjects } from "../projects/workspace-projects";
import { useNavigate } from "../shell/use-navigate";
import type { WorkspaceEventFeed } from "../../lib/files/workspace-events";
import { FolderErrors, FolderNote, RootHeader, Status } from "./file-browser-parts";
import { FileBrowserDialog } from "./file-browser-dialogs";
import { treeActions } from "./file-tree-actions";
import { useFileActions } from "./use-file-actions";
import { useTreeFocus } from "./use-tree-focus";
import { useWake, useWorkspaceEvents } from "./use-wake";
import { VolumeLostNotice } from "./volume-lost-notice";

/** The sandbox syncs shortly after it starts; read the listing again after this. */
const DEFAULT_REFRESH_AFTER_WAKE_MS = 4000;

type FileBrowserProps = {
  readonly api: FilesApi;
  /**
   * The threads that used each file (KOBE-612, TFM4): "Used in (N threads)" in a file's menu,
   * read in batches for the files on screen; choosing a thread opens it. Absent: no such item.
   */
  readonly fileLinks?:
    { readonly api: FileLinksApi; openThread(threadId: string): void } | undefined;
  /**
   * The workspace's change hints (KOBE-599): the tree lists again when the member's files or the
   * projects change. Absent: only Refresh lists again.
   */
  readonly events?: WorkspaceEventFeed | undefined;
  /**
   * The member may create projects (team admins, contributors): My files folders offer Promote to
   * project… (KOBE-586, PF1). False: no such item.
   */
  readonly canCreateProjects?: boolean | undefined;
  /** A folder became this project (PF6): the conversation's project control may offer it. */
  readonly onPromoted?: ((project: ProjectRef) => void) | undefined;
  /** The project of the conversation on screen, or of the new one being drafted (FP2). */
  readonly activeProjectId?: string | null | undefined;
  /** Whether project rows show "editing ●" for a checkout (false in a private conversation, FP3). */
  readonly showEditing?: boolean | undefined;
  /** "New conversation in this project" on a greyed project (FP4). Absent: no such item. */
  readonly onNewConversationIn?: ((project: ProjectRef) => void) | undefined;
  /**
   * "Move this conversation here" on a greyed project (FP4): offered only when the conversation
   * on screen is the member's own; the answer is why it could not move, or undefined once it did.
   */
  readonly onMoveHere?: ((project: ProjectRef) => Promise<string | undefined>) | undefined;
  /** The active workspace's name (the switcher's): the tree's top row (FP1). */
  readonly workspaceName?: string | undefined;
  /** Refresh files in the top row (KOBE-461): wakes and lists again (a new `wakeKey`). Absent: none. */
  readonly onRefresh?: (() => void) | undefined;
  /**
   * "Mention in message" (KOBE-374): the file goes into the composer as an @file mention; the
   * answer is why it could not, or undefined once it did. Absent: no such item.
   */
  readonly onMention?: ((entry: FileEntry) => string | undefined) | undefined;
  /** A file opens in the artifact column (KOBE-268). */
  readonly onOpenFile?: ((entry: FileEntry) => void) | undefined;
  /** A file or folder moved: open tabs of it follow (KOBE-304, ac-9). */
  readonly onMoved?: ((from: string, to: string) => void) | undefined;
  readonly refreshAfterWakeMs?: number;
  /** A new value wakes the sandbox and lists again (Show files, refresh). */
  readonly wakeKey?: number;
  /** Reveals this folder, once per `seq` (uploads/ after a rail drop, KOBE-199). */
  readonly showFolder?: { readonly path: string; readonly seq: number } | null;
};

/**
 * The workspace rail's Files (KOBE-148, KOBE-304): a compact tree of the caller's synced
 * workspace with file-type icons. Files open in the artifact column (KOBE-268); each row has the
 * ⋯ menu (KOBE-292); files and folders move by drag and drop or Move to…, and rename with F2 or
 * the menu, through the server's move API, which decides; files dropped from the computer onto a
 * folder upload there (anywhere else on the rail they go to uploads/, KOBE-199).
 */
export function FileBrowser({
  api,
  workspaceName = "",
  refreshAfterWakeMs = DEFAULT_REFRESH_AFTER_WAKE_MS,
  wakeKey = 0,
  showFolder = null,
  onOpenFile,
  onMoved,
  onMention,
  onRefresh,
  activeProjectId = null,
  showEditing = true,
  onNewConversationIn,
  onMoveHere,
  canCreateProjects = false,
  onPromoted,
  events,
  fileLinks,
}: FileBrowserProps) {
  const heads = useProjectHeads(api);
  const tree = useFileTree(heads, expandedKey(api.teamId));
  const workspaceProjects = useWorkspaceProjects();
  const { reloadAll } = tree;
  const reloadProjects = workspaceProjects?.reload;
  const projectsLoaded = workspaceProjects !== null && workspaceProjects.status !== "idle";
  /** Everything on screen again: folders (open ones stay open), project heads and rows. */
  const relist = useCallback(
    (projects = true) => {
      if (projects) {
        heads.forget();
        if (projectsLoaded) reloadProjects?.();
      }
      reloadAll();
    },
    [heads, reloadAll, reloadProjects, projectsLoaded],
  );
  const relistRef = useRef(relist);
  relistRef.current = relist;
  const stableRelist = useCallback(() => relistRef.current(), []);
  const { waking, syncing, limited } = useWake(api, stableRelist, refreshAfterWakeMs, wakeKey);
  useWorkspaceEvents(events, (moved) => relistRef.current(moved.projects));
  const { focus, focusRequest, focusFrom, enterTree, focusRow } = useTreeFocus();
  const shownSeq = useRef(showFolder?.seq ?? 0);
  const { reveal } = tree;
  const work = useProjectsInTree(tree, activeProjectId, showEditing);
  const { checkedOut } = work;
  const shownFiles = useMemo(
    () =>
      fileLinks === undefined
        ? []
        : tree.rows.flatMap((r) =>
            r.kind === "entry" && r.entry.type === "file" ? [r.entry.path] : [],
          ),
    [fileLinks, tree.rows],
  );
  const fileThreads = useFileThreads(fileLinks?.api ?? null, shownFiles);
  const split = useMemo(() => splitProjectRows(tree.rows), [tree.rows]);
  const projectsTree = useMemo(() => ({ ...tree, rows: work.rows }), [tree, work.rows]);
  const myTree = useMemo(() => ({ ...tree, rows: split.mine }), [tree, split]);
  const [projectAction, setProjectAction] = useState<{
    readonly project: ProjectRef;
    readonly action: WorkAction;
  } | null>(null);
  const navigate = useNavigate();
  const projectsApi = useMemo(
    () => workspaceProjects?.projects ?? createProjectsApi(api.teamId),
    [workspaceProjects?.projects, api.teamId],
  );
  const act = useFileActions({
    api,
    tree,
    mentionRefusal: work.mentionRefusal,
    retryProjects: work.retry,
    focusRow,
    onMention,
    onMoved,
    onPromoted,
    onMoveHere,
  });

  const firstShow = useRef(true);
  useEffect(() => {
    if (!showFolder) return;
    if (showFolder.seq === shownSeq.current && !firstShow.current) return;
    firstShow.current = false;
    shownSeq.current = showFolder.seq;
    reveal(showFolder.path); // a drop landed there: open it and list it again
  }, [showFolder, reveal]);

  const { actions, projectActions } = treeActions({
    work,
    act,
    tree,
    fileThreads,
    fileLinks,
    focusRow,
    onOpenFile,
    onMention,
    canCreateProjects,
    activeProjectId,
    onNewConversationIn,
    onMoveHere,
    onProjectAction: (project, action) => setProjectAction({ project, action }),
    onOpenProjectPage: (id) => navigate(`/me/projects/${id}`),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-2 py-1.5">
      {waking && (
        <p role="status" className="text-muted-foreground m-0 text-xs">
          Showing the last synced files while your sandbox wakes.
        </p>
      )}
      {limited !== null && (
        <p role="status" className="text-muted-foreground m-0 text-xs">
          {limited} Showing the last synced files; sending a message still works.
        </p>
      )}
      <VolumeLostNotice api={api.rebuild} mode="check" />
      <FolderErrors tree={tree} />
      {act.actionError && <ErrorNotice error={act.actionError} />}
      <WorkspaceHeader name={workspaceName} onRefresh={onRefresh} syncing={syncing} />
      {work.failed && (
        <p role="alert" className="m-0 text-xs">
          Your projects could not be read, so none shows as checked out.{" "}
          <button type="button" className="underline" onClick={work.retry}>
            Try again
          </button>
        </p>
      )}
      <div className="contents" onFocusCapture={enterTree("projects")}>
        <FileTreeView
          tree={projectsTree}
          label="Projects"
          idPrefix="kobe-projects-row"
          actions={projectActions}
          focusRequest={focusRequest}
          onFocusChange={focusFrom.projects}
          header={() => (
            <>
              <ProjectsHeader />
              {work.showFilter && <ProjectsFilter value={work.filter} onChange={work.setFilter} />}
            </>
          )}
        />
      </div>
      {work.hidden > 0 && !work.showAll && work.filter === "" && (
        <ShowAllProjects total={work.all} onShow={() => work.setShowAll(true)} />
      )}
      {work.rows.length === 0 && <NoProjects ready={work.ready} filtered={work.filter !== ""} />}
      {projectAction && (
        <ProjectWorkPanel
          key={`${projectAction.project.id}:${projectAction.action}`}
          project={projectAction.project}
          action={projectAction.action}
          onClose={() => setProjectAction(null)}
        />
      )}
      <div className="contents" onFocusCapture={enterTree("mine")}>
        <FileTreeView
          tree={myTree}
          label="My files"
          actions={actions}
          focusRequest={focusRequest}
          onFocusChange={focusFrom.mine}
          header={(drag) => (
            <RootHeader
              drag={drag}
              folder={focus.folder}
              busy={act.busy}
              checkedOut={checkedOut}
              onUpload={(files) =>
                void act.uploadInto(focus.folder, { files: Array.from(files ?? []), folders: [] })
              }
            />
          )}
        />
      </div>
      <Status tree={tree} empty={split.mine.length === 0} />
      <FolderNote folder={focus.folder} checkedOut={checkedOut} />
      <FileBrowserDialog
        dialog={act.dialog}
        busy={act.busy}
        checkedOut={checkedOut}
        folders={tree.knownFolders}
        projectsApi={projectsApi}
        onRemove={(entry) => void act.remove(entry)}
        onMove={(from, to, verb) => void act.move(from, to, verb)}
        onPromoted={act.promoted}
        onClose={act.closeDialog}
      />
      <p role="status" className="sr-only">
        {act.notice}
      </p>
    </div>
  );
}
