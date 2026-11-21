import type { FileEntry } from "../../lib/files/api";
import type { DroppedItems } from "../../lib/files/drop";
import { baseName, joinPath } from "../../lib/files/tree";
import { isProjectFolder } from "../../lib/projects/workspace";
import { offersPromote } from "../../lib/projects/promote";
import type { MenuBindings } from "../../lib/shell/menu";
import type { FileThreads } from "../../lib/threads/file-links";
import type { ProjectRef, WorkAction } from "../projects/project-work";
import { projectBindings, rowBindings, usedInBindings } from "./file-row-menus";
import type { Dragging, TreeActions } from "./file-tree";
import type { useFileActions } from "./use-file-actions";
import type { FileTree } from "./use-file-tree";
import type { useProjectsInTree } from "./workspace-tree";

/**
 * What the file browser's two trees do with a row (KOBE-292, KOBE-304, Workspaces FP4): `actions`
 * for My files; `projectActions` adds the project folders' own items and decorations.
 */
export function treeActions({
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
  onProjectAction,
  onOpenProjectPage,
}: {
  readonly work: ReturnType<typeof useProjectsInTree>;
  readonly act: ReturnType<typeof useFileActions>;
  readonly tree: Pick<FileTree, "expand">;
  readonly fileThreads: ReadonlyMap<string, FileThreads>;
  readonly fileLinks: { openThread(threadId: string): void } | undefined;
  readonly focusRow: (path: string) => void;
  readonly onOpenFile: ((entry: FileEntry) => void) | undefined;
  readonly onMention: ((entry: FileEntry) => string | undefined) | undefined;
  readonly canCreateProjects: boolean;
  readonly activeProjectId: string | null;
  readonly onNewConversationIn: ((project: ProjectRef) => void) | undefined;
  readonly onMoveHere: ((project: ProjectRef) => Promise<string | undefined>) | undefined;
  readonly onProjectAction: (project: ProjectRef, action: WorkAction) => void;
  readonly onOpenProjectPage: (projectId: string) => void;
}): { readonly actions: TreeActions; readonly projectActions: TreeActions } {
  const { checkedOut } = work;
  const { setDialog } = act;
  // A file of a project that is not mounted is listed, not in the sandbox: it opens nowhere.
  const notMounted = (entry: FileEntry) => work.mentionRefusal(entry.path) !== undefined;
  const openHere = onOpenFile
    ? (entry: FileEntry) => {
        const refused = work.mentionRefusal(entry.path);
        if (refused === undefined) return onOpenFile(entry);
        act.note(refused.replace("to mention its files", "to open its files"));
      }
    : undefined;
  const actions = {
    onOpenFile: openHere,
    mentionRefusal: work.mentionRefusal,
    bindings: (entry: FileEntry): MenuBindings =>
      entry.type === "file" && notMounted(entry)
        ? ({} as MenuBindings)
        : {
            ...usedInBindings(
              entry,
              fileThreads,
              fileLinks && ((threadId) => fileLinks.openThread(threadId)),
            ),
            ...rowBindings(entry, checkedOut, {
              onOpen:
                entry.type === "dir"
                  ? () => {
                      tree.expand(entry.path);
                      focusRow(entry.path);
                    }
                  : openHere && (() => openHere(entry)),
              onMention: onMention && (() => act.mention(entry)),
              onDownload: () => void act.download(entry),
              onRename: () => setDialog({ kind: "rename", entry }),
              onMove: () => setDialog({ kind: "move", entry }),
              onCopyPath: () => act.copyPath(entry),
              onDelete: () => setDialog({ kind: "delete", entry }),
              onPromote: offersPromote(entry, canCreateProjects)
                ? () => setDialog({ kind: "promote", entry })
                : undefined,
            }),
          },
    onRename: (entry: FileEntry) => setDialog({ kind: "rename", entry }),
    onDelete: (entry: FileEntry) => setDialog({ kind: "delete", entry }),
    onMove: (dragging: Dragging, folder: string) =>
      void act.move(dragging.path, joinPath(folder, baseName(dragging.path)), "Moved"),
    onUpload: (folder: string, items: DroppedItems) => void act.uploadInto(folder, items),
    checkedOut,
    dropRefusal: work.dropRefusal,
    onRefusedDrop: (reason: string) => act.note(reason),
  };
  const projectActions = {
    ...actions,
    decorate: work.decorate,
    bindings: (entry: FileEntry): MenuBindings => {
      const own = actions.bindings(entry);
      const project = isProjectFolder(entry.path) ? work.projectOf(entry.path) : undefined;
      if (!project) return own;
      return {
        ...own,
        ...projectBindings(project, activeProjectId, {
          onAction: onProjectAction,
          onNewConversationIn,
          onMoveHere: onMoveHere && ((ref) => void act.moveHere(ref)),
          onOpenPage: onOpenProjectPage,
        }),
      };
    },
  };
  return { actions, projectActions };
}
