"use client";

import type { ReactNode } from "react";
import { FolderIcon, UploadIcon } from "lucide-react";
import { WORKSPACE_DROP_FOLDER } from "@kaiju/protocol";
import { describeFileError, isReadOnlyPath } from "../../lib/files/format";
import { canUploadInto } from "../../lib/files/tree";
import { projectSlugOf } from "../../lib/projects/workspace";
import { cn } from "../../lib/utils";
import { ErrorNotice } from "../admin/error-notice";
import { DROP_FOLDER_ATTR, type FileTreeView } from "./file-tree";
import type { FileTree } from "./use-file-tree";

/** A folder as notices name it: the top level is "My files". */
export const where = (folder: string) => (folder === "" ? "My files" : folder);

/**
 * My files' top row (Workspaces FP1; the member's scratchspace): a drop target for its top level
 * and Upload (into the focused folder).
 */
export function RootHeader({
  drag,
  folder,
  busy,
  checkedOut,
  onUpload,
}: {
  readonly drag: Parameters<Parameters<typeof FileTreeView>[0]["header"]>[0];
  readonly folder: string;
  readonly busy: boolean;
  readonly checkedOut: ReadonlySet<string> | undefined;
  onUpload(files: FileList | null): void;
}) {
  const label = `Upload a file to ${where(folder)}`;
  return (
    <div
      {...{ [DROP_FOLDER_ATTR]: "" }}
      {...(drag.target === "" ? { "data-drop-target": "" } : {})}
      className={cn(
        "flex h-6.5 items-center gap-1 rounded-sm ps-0.5 text-xs font-medium",
        drag.target === "" && "bg-accent ring-ring ring-1 ring-inset",
      )}
      onDragOver={(e) => drag.handlers.over(e, "", true)}
      onDrop={(e) => drag.handlers.drop(e, "", true)}
    >
      <FolderIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">My files</span>
      {takesUploads(folder, checkedOut) && (
        <label
          className={cn(
            "hover:bg-muted flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
            busy && "pointer-events-none opacity-50",
          )}
          title={label}
        >
          <UploadIcon aria-hidden className="size-3.5" />
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={busy}
            aria-label={label}
            onChange={(e) => {
              onUpload(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}

/**
 * Whether Upload may target `folder`: inside a project, whether it takes files (a checked-out
 * project's own folder does, CM3); elsewhere today's read-only rule.
 */
function takesUploads(folder: string, checkedOut: ReadonlySet<string> | undefined): boolean {
  return projectSlugOf(folder) !== undefined
    ? canUploadInto(folder, checkedOut)
    : !isReadOnlyPath(folder);
}

export function FolderNote({
  folder,
  checkedOut,
}: {
  readonly folder: string;
  readonly checkedOut: ReadonlySet<string> | undefined;
}) {
  if (takesUploads(folder, checkedOut)) return null;
  return (
    <p className="text-muted-foreground m-0 text-xs">
      {folder === WORKSPACE_DROP_FOLDER
        ? "Drop files on the rail to add them here. Files your threads attached are read-only."
        : projectSlugOf(folder) !== undefined
          ? "This project is read-only here: check it out to change its files."
          : "This folder is read-only: files here cannot be uploaded or deleted."}
    </p>
  );
}

export function Status({ tree, empty }: { readonly tree: FileTree; readonly empty: boolean }) {
  const { root } = tree;
  if (root.loading && root.entries.length === 0 && !root.error) {
    return (
      <p role="status" className="m-0 text-xs">
        Loading files…
      </p>
    );
  }
  if (!root.loading && !root.error && empty) {
    return <p className="text-muted-foreground m-0 text-xs">No files yet.</p>;
  }
  return null;
}

export function FolderErrors({ tree }: { readonly tree: FileTree }): ReactNode {
  return (
    <>
      {tree.root.error && <ErrorNotice error={describeFileError(tree.root.error)} />}
      {tree.errors.map(({ folder, load }) =>
        load.error ? (
          <ErrorNotice
            key={folder}
            error={{
              ...describeFileError(load.error),
              message: `${folder}: ${describeFileError(load.error).message}`,
            }}
          />
        ) : null,
      )}
    </>
  );
}
