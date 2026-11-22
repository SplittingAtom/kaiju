import type { FileEntry } from "../../lib/files/api";
import { isReadOnlyPath } from "../../lib/files/format";
import type { MenuBindings } from "../../lib/shell/menu";
import type { FileThreads } from "../../lib/threads/file-links";
import { threadsUsing, usedInLabel } from "../../lib/threads/file-map";
import type { ProjectRef, WorkAction } from "../projects/project-work";
import type { useProjectsInTree } from "./workspace-tree";

/**
 * A row's ⋯ menu (KOBE-292, KOBE-304): Open, Mention in message (files, KOBE-374), Download,
 * Rename, Move to…, Copy path, Promote to project… (a My files folder, KOBE-586), Delete.
 */
export function rowBindings(
  entry: FileEntry,
  checkedOut: ReadonlySet<string> | undefined,
  handlers: {
    readonly onOpen: (() => void) | undefined;
    readonly onMention: (() => void) | undefined;
    readonly onDownload: () => void;
    readonly onRename: () => void;
    readonly onMove: () => void;
    readonly onCopyPath: () => void;
    readonly onDelete: () => void;
    /** Present only where the row offers it (PF1: a My files folder, team admins and contributors). */
    readonly onPromote: (() => void) | undefined;
  },
): MenuBindings {
  const readOnly = isReadOnlyPath(entry.path, checkedOut);
  const change = (onSelect: () => void, destructive = false) => ({
    onSelect,
    movesFocus: true,
    ...(destructive ? { destructive } : {}),
  });
  return {
    ...(handlers.onOpen ? { "open-file": { onSelect: handlers.onOpen } } : {}),
    // Focus goes to the composer, so the menu doesn't give it back to its button.
    ...(entry.type === "file" && handlers.onMention
      ? { "mention-file": { onSelect: handlers.onMention, movesFocus: true } }
      : {}),
    ...(entry.type === "file" ? { "download-file": { onSelect: handlers.onDownload } } : {}),
    ...(readOnly
      ? {}
      : { "rename-file": change(handlers.onRename), "move-file": change(handlers.onMove) }),
    "copy-file-path": { onSelect: handlers.onCopyPath },
    ...(handlers.onPromote ? { "promote-to-project": change(handlers.onPromote) } : {}),
    ...(readOnly ? {} : { "delete-file": change(handlers.onDelete, true) }),
  };
}

/** "Used in (N threads)" (TFM4): the threads that read or wrote the file, as a submenu. */
export function usedInBindings(
  entry: FileEntry,
  fileThreads: ReadonlyMap<string, FileThreads>,
  openThread: ((threadId: string) => void) | undefined,
): MenuBindings {
  if (openThread === undefined || entry.type !== "file") return {};
  const uses = threadsUsing(entry.path, false, new Map(), fileThreads);
  const count = uses.length + (fileThreads.get(entry.path)?.more ?? 0);
  if (count === 0) return {};
  return {
    "file-used-in":
      uses.length === 0
        ? { label: usedInLabel(count), blocker: "Only in threads you can't open." }
        : {
            label: usedInLabel(count),
            choices: uses.map((t) => ({
              key: t.threadId,
              label: t.title || "Untitled conversation",
              onSelect: () => openThread(t.threadId),
            })),
          },
  };
}

type KnownProject = NonNullable<ReturnType<ReturnType<typeof useProjectsInTree>["projectOf"]>>;

/**
 * A project folder's own items (Workspaces FP4, CM): commit, update, discard or check out; and,
 * for a project other than the conversation's, new conversation in it or move this one there.
 */
export function projectBindings(
  project: KnownProject,
  activeProjectId: string | null,
  handlers: {
    readonly onAction: (ref: ProjectRef, action: WorkAction) => void;
    readonly onNewConversationIn: ((project: ProjectRef) => void) | undefined;
    readonly onMoveHere: ((ref: ProjectRef) => void) | undefined;
    readonly onOpenPage: (projectId: string) => void;
  },
): MenuBindings {
  const ref = { id: project.project.id, name: project.project.name };
  const act = (action: WorkAction) => ({
    onSelect: () => handlers.onAction(ref, action),
    movesFocus: true,
  });
  const { onNewConversationIn, onMoveHere } = handlers;
  return {
    ...(project.kind === "checked_out"
      ? {
          "commit-project": act("commit"),
          "update-project": act("update"),
          "discard-project": { ...act("discard"), destructive: true },
        }
      : project.kind === "editable"
        ? { "checkout-project": act("checkout") }
        : {}),
    ...(project.project.id === activeProjectId
      ? {}
      : {
          ...(onNewConversationIn
            ? {
                "new-conversation-in-project": {
                  onSelect: () => onNewConversationIn(ref),
                  movesFocus: true,
                },
              }
            : {}),
          ...(onMoveHere
            ? {
                "move-conversation-here": {
                  onSelect: () => onMoveHere(ref),
                  movesFocus: true,
                },
              }
            : {}),
        }),
    "open-project-page": { onSelect: () => handlers.onOpenPage(project.project.id) },
  };
}
