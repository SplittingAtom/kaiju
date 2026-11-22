"use client";

import { useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { copyText } from "../../lib/clipboard";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import type { DroppedItems } from "../../lib/files/drop";
import { folderError } from "../../lib/files/drop";
import { describeFileError, parentPath } from "../../lib/files/format";
import { saveBytes } from "../../lib/files/save";
import { baseName } from "../../lib/files/tree";
import type { Project } from "../../lib/projects/api";
import { PROJECTS_FOLDER } from "../../lib/projects/workspace";
import type { ProjectRef } from "../projects/project-work";
import { where } from "./file-browser-parts";
import type { FileTree } from "./use-file-tree";

const COPY_FAILED = {
  status: 0,
  code: "client_error",
  message: "The path could not be copied: the browser refused the clipboard.",
} as const;

export type Dialog = {
  readonly kind: "delete" | "rename" | "move" | "promote";
  readonly entry: FileEntry;
} | null;

/**
 * The file browser's actions on files and folders (KOBE-148, KOBE-292, KOBE-304): download,
 * mention, copy path, delete, move and rename, upload, promote; and the state they share: the
 * open dialog, `busy` while one runs, the last error and the screen-reader notice.
 */
export function useFileActions({
  api,
  tree,
  mentionRefusal,
  retryProjects,
  focusRow,
  onMention,
  onMoved,
  onPromoted,
  onMoveHere,
}: {
  readonly api: FilesApi;
  readonly tree: Pick<FileTree, "reveal" | "moved" | "reloadAll">;
  readonly mentionRefusal: (path: string) => string | undefined;
  readonly retryProjects: () => void;
  readonly focusRow: (path: string) => void;
  readonly onMention: ((entry: FileEntry) => string | undefined) | undefined;
  readonly onMoved: ((from: string, to: string) => void) | undefined;
  readonly onPromoted: ((project: ProjectRef) => void) | undefined;
  readonly onMoveHere: ((project: ProjectRef) => Promise<string | undefined>) | undefined;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const { reveal, moved } = tree;

  const start = () => {
    setActionError(null);
    setNotice("");
  };

  const closeDialog = (entry: FileEntry) => {
    setDialog(null);
    focusRow(entry.path);
  };

  const download = async (entry: FileEntry) => {
    start();
    const res = await api.download(entry.path);
    if (!res.ok) return setActionError(describeFileError(res.error));
    saveBytes(entry.name, res.data);
    setNotice(`Downloaded ${entry.name}`);
  };

  const mention = (entry: FileEntry) => {
    start();
    const refused = mentionRefusal(entry.path) ?? onMention?.(entry);
    if (refused !== undefined) {
      focusRow(entry.path);
      return setActionError({ status: 0, code: "client_error", message: refused });
    }
    setNotice(`Mentioned ${entry.name} in your message`);
  };

  /** The path inside the workspace (the agent's working directory), as the listing names it. */
  const copyPath = (entry: FileEntry) => {
    copyText(entry.path).then(
      () => setNotice(`Copied the path of ${entry.name}`),
      () => setActionError(COPY_FAILED),
    );
  };

  const remove = async (entry: FileEntry) => {
    setBusy(true);
    start();
    const res = await api.remove(entry.path);
    setBusy(false);
    setDialog(null);
    if (!res.ok) {
      focusRow(entry.path);
      return setActionError(describeFileError(res.error));
    }
    setNotice(`Deleted ${entry.name}`);
    reveal(parentPath(entry.path));
    focusRow(parentPath(entry.path));
  };

  const move = async (from: string, to: string, verb: "Moved" | "Renamed") => {
    setBusy(true);
    start();
    const res = await api.move(from, to);
    setBusy(false);
    setDialog(null);
    if (!res.ok) {
      focusRow(from);
      return setActionError(describeFileError(res.error));
    }
    moved(from, to);
    reveal(parentPath(from));
    if (parentPath(to) !== parentPath(from)) reveal(parentPath(to));
    onMoved?.(from, to);
    setNotice(
      verb === "Renamed"
        ? `Renamed ${baseName(from)} to ${baseName(to)}`
        : `Moved ${baseName(from)} to ${where(parentPath(to))}`,
    );
    focusRow(to);
  };

  const uploadInto = async (folder: string, items: DroppedItems) => {
    setBusy(true);
    start();
    const done: string[] = [];
    if (items.folders.length > 0) setActionError(folderError(items.folders));
    for (const file of items.files) {
      const res = await api.upload(folder, file);
      if (!res.ok) {
        const described = describeFileError(res.error);
        setActionError({ ...described, message: `${file.name}: ${described.message}` });
        if (res.error.code === "quota_exceeded") break;
        continue;
      }
      done.push(res.data.name);
    }
    setBusy(false);
    if (done.length > 0) {
      setNotice(`Uploaded ${done.join(", ")}`);
      reveal(folder);
    }
  };

  /** PF6: the tree lists again and reveals the new project under Projects. */
  const promoted = (entry: FileEntry, project: Project) => {
    setDialog(null);
    start();
    setNotice(`Moved ${entry.name} into the new project ${project.name}`);
    retryProjects();
    tree.reloadAll();
    reveal(PROJECTS_FOLDER);
    focusRow(`${PROJECTS_FOLDER}/${project.slug}`);
    onPromoted?.({ id: project.id, name: project.name });
  };

  const moveHere = async (ref: ProjectRef) => {
    start();
    const refused = await onMoveHere?.(ref);
    if (refused !== undefined) {
      return setActionError({ status: 0, code: "client_error", message: refused });
    }
    setNotice(`Moved this conversation to ${ref.name}`);
  };

  /** A note instead of an action (a refused drop, a file that opens nowhere). */
  const note = (message: string) => {
    setActionError(null);
    setNotice(message);
  };

  return {
    dialog,
    setDialog,
    busy,
    actionError,
    notice,
    closeDialog,
    download,
    mention,
    copyPath,
    remove,
    move,
    uploadInto,
    promoted,
    moveHere,
    note,
  };
}
