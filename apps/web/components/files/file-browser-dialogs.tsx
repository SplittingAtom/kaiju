"use client";

import type { FileEntry } from "../../lib/files/api";
import { parentPath } from "../../lib/files/format";
import { baseName, joinPath } from "../../lib/files/tree";
import type { Project, ProjectsApi } from "../../lib/projects/api";
import { ConfirmDelete, MoveForm, RenameForm } from "./file-dialogs";
import { PromoteDialog } from "./promote-dialog";
import type { Dialog } from "./use-file-actions";

/** The file browser's open dialog, if any: delete, rename, promote to project, or move. */
export function FileBrowserDialog({
  dialog,
  busy,
  checkedOut,
  folders,
  projectsApi,
  onRemove,
  onMove,
  onPromoted,
  onClose,
}: {
  readonly dialog: Dialog;
  readonly busy: boolean;
  readonly checkedOut: ReadonlySet<string> | undefined;
  readonly folders: readonly FileEntry[];
  readonly projectsApi: ProjectsApi;
  onRemove(entry: FileEntry): void;
  onMove(from: string, to: string, verb: "Moved" | "Renamed"): void;
  onPromoted(entry: FileEntry, project: Project): void;
  onClose(entry: FileEntry): void;
}) {
  if (dialog === null) return null;
  const { entry } = dialog;
  switch (dialog.kind) {
    case "delete":
      return (
        <ConfirmDelete
          entry={entry}
          busy={busy}
          onConfirm={() => onRemove(entry)}
          onCancel={() => onClose(entry)}
        />
      );
    case "rename":
      return (
        <RenameForm
          entry={entry}
          busy={busy}
          onRename={(name) => onMove(entry.path, joinPath(parentPath(entry.path), name), "Renamed")}
          onCancel={() => onClose(entry)}
        />
      );
    case "promote":
      return (
        <PromoteDialog
          entry={entry}
          api={projectsApi}
          onDone={(project) => onPromoted(entry, project)}
          onCancel={() => onClose(entry)}
        />
      );
    case "move":
      return (
        <MoveForm
          entry={entry}
          checkedOut={checkedOut}
          folders={folders}
          busy={busy}
          onMove={(folder) => onMove(entry.path, joinPath(folder, baseName(entry.path)), "Moved")}
          onCancel={() => onClose(entry)}
        />
      );
  }
}
