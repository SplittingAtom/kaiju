"use client";

import { threadExportUrl } from "../../lib/chat/api";
import type { FolderView } from "../../lib/chat/folders-api";
import { placementOf } from "../../lib/chat/thread-groups";
import {
  folderPath,
  type PanelNode,
  type PlacedFolder,
  type TreeCounts,
  type TreeRow,
} from "../../lib/chat/folder-tree";
import { FolderEditor, type FolderActions } from "./folder-node-menu";
import { FolderPicker } from "./folder-picker";
import { FolderTree } from "./folder-tree";
import { IconAction } from "./icon-action";
import { RAIL_ACTION, RAIL_ACTION_VARIANT } from "./rail-action";
import { FolderNote } from "./threads-search";
import type { useListedThreads } from "./use-listed-threads";

/**
 * The Threads panel's folders: on wide windows the folder tree (with New folder), else a
 * dropdown above the threads (KOBE-536, TF7).
 */
export function FolderColumn({
  wide,
  threeRails,
  rows,
  counts,
  node,
  placed,
  chosenPlaced,
  actions,
  announce,
  choose,
  setOpen,
  fileByDrop,
}: {
  readonly wide: boolean;
  readonly threeRails: boolean;
  readonly rows: readonly TreeRow[];
  readonly counts: TreeCounts;
  readonly node: PanelNode;
  readonly placed: readonly PlacedFolder[];
  readonly chosenPlaced: PlacedFolder | undefined;
  readonly actions: FolderActions;
  announce(text: string): void;
  choose(next: PanelNode): void;
  setOpen(target: PanelNode, open: boolean): void;
  fileByDrop(threadId: string, folderId: string | null): void;
}) {
  return wide ? (
    <nav
      aria-label="Folders"
      className={`flex min-w-0 flex-col gap-2 ${threeRails ? "min-h-0 overflow-y-auto" : ""}`}
    >
      <FolderTree
        rows={rows}
        chosen={node}
        choose={choose}
        setOpen={setOpen}
        bindings={(row) => (row.placed ? actions.bindings(row.placed) : null)}
        onDropThread={fileByDrop}
      />
      <FolderEditor actions={actions} announce={announce} />
      <button
        type="button"
        className="self-start border-0 bg-transparent px-1 py-0 text-sm underline"
        onClick={() => actions.startNew(null)}
      >
        + New folder
      </button>
    </nav>
  ) : (
    <div className="flex flex-col gap-2">
      <FolderPicker
        placed={placed}
        counts={counts}
        chosen={node}
        choose={choose}
        onNewFolder={() => actions.startNew(null)}
        chosenBindings={chosenPlaced ? actions.bindings(chosenPlaced) : null}
        chosenName={chosenPlaced?.folder.name ?? ""}
      />
      <FolderEditor actions={actions} announce={announce} />
    </div>
  );
}

/** The panel's search box and Export (the team's threads as a zip). */
export function ThreadsSearchBar({
  query,
  setQuery,
  teamId,
}: {
  readonly query: string;
  setQuery(query: string): void;
  readonly teamId: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="search"
        aria-label="Search threads"
        placeholder="Search threads"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
      />
      <IconAction
        command="export-threads"
        href={threadExportUrl(teamId)}
        download
        description="This team's, as Pi sessions and Markdown in a zip"
        size="sm"
        side="left"
        variant={RAIL_ACTION_VARIANT}
        className={RAIL_ACTION}
      />
    </div>
  );
}

/**
 * Where the listed threads are: the archived ones (with their folder as a note) and, for a thread
 * without a row, its place (spec §5: "3 in Archived").
 */
export function threadPlaces(
  listed: ReturnType<typeof useListedThreads>,
  items: readonly { readonly id: string; readonly remoteId?: string | undefined }[],
  list: readonly FolderView[],
  trashIds: readonly string[],
) {
  const archived = listed.flatMap((t, index) =>
    placementOf(t.custom).archived ? [{ id: t.id, index }] : [],
  );
  const archivedNotes = new Map(
    archived.flatMap(({ id }) => {
      const t = listed.find((l) => l.id === id);
      if (!t) return [];
      const remoteId = items.find((i) => i.id === t.id)?.remoteId;
      const path = folderPath(list, placementOf(t.custom).folderId);
      return remoteId && path ? [[remoteId, <FolderNote key={t.id} path={path} />] as const] : [];
    }),
  );
  const placeOf = (threadId: string): string | null => {
    const local = items.find((i) => i.remoteId === threadId)?.id;
    const t = local === undefined ? undefined : listed.find((l) => l.id === local);
    if (!t) return trashIds.includes(local ?? "") ? "Deleted" : null;
    const p = placementOf(t.custom);
    if (p.archived) return "Archived";
    return p.folderId === null ? "Current" : (folderPath(list, p.folderId) ?? null);
  };
  return { archived, archivedNotes, placeOf };
}
