"use client";

import { SEMANTIC_MEMORY_SCOPES } from "@kaiju/protocol";
import { useEffect, useState } from "react";
import { isUuid } from "../../lib/memory/ids";
import type { ItemScope, MemoryItem, MemoryItemsApi } from "../../lib/memory/items-api";
import { Notice, Section } from "../ui/console";
import { ItemRow, type Done } from "./item-row";

/** The heading of the opened memory: focus lands here once it loads. */
const OPENED_HEADING = "memory-opened";

/** `?item=<uuid>` (and an optional valid `&scope=`) from an "Open in Memory" link (KOBE-399). */
export function openedFromLocation(
  search: string,
): { readonly id: string; readonly scope?: ItemScope } | null {
  const params = new URLSearchParams(search);
  const id = params.get("item");
  if (id === null || !isUuid(id)) return null;
  const scope = params.get("scope");
  return (SEMANTIC_MEMORY_SCOPES as readonly string[]).includes(scope ?? "")
    ? { id, scope: scope as ItemScope }
    : { id };
}

type Opened =
  | { readonly status: "loading" }
  | { readonly status: "gone" }
  | { readonly status: "ready"; readonly item: MemoryItem };

/** The item in the first scope that has it (the link's scope only, when it names one). */
async function find(
  api: MemoryItemsApi,
  id: string,
  scope: ItemScope | undefined,
): Promise<MemoryItem | null> {
  for (const s of scope === undefined ? SEMANTIC_MEMORY_SCOPES : [scope]) {
    const res = await api.get(s, id);
    if (res.ok) return res.data;
  }
  return null;
}

/**
 * The memory an "Open in Memory" chip linked to (KOBE-399, SM26), shown first on the Memories tab:
 * your own (this workspace or all of them) with Edit, Pin and Archive, every change announced with
 * Undo by the page; a Workspace or Site memory read-only (curators change those). The person's
 * "forget it" ends here: an archived memory is never given to an agent again.
 */
export function OpenedMemory({
  api,
  known,
  undone,
  onChanged,
}: {
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  /** The last item the page's Undo brought back: shown here when it is this one. */
  readonly undone: MemoryItem | null;
  /** A change made here (the page places it in its lists and shows Undo). */
  readonly onChanged: (item: MemoryItem, done: Done) => void;
}) {
  const [target] = useState(() => openedFromLocation(window.location.search));
  const [opened, setOpened] = useState<Opened>({ status: "loading" });

  useEffect(() => {
    if (target === null) return;
    let live = true;
    void find(api, target.id, target.scope).then((item) => {
      if (!live) return;
      setOpened(item === null ? { status: "gone" } : { status: "ready", item });
      if (item !== null) queueMicrotask(() => document.getElementById(OPENED_HEADING)?.focus());
    });
    return () => {
      live = false;
    };
  }, [api, target]);

  useEffect(() => {
    if (undone !== null && undone.id === target?.id) setOpened({ status: "ready", item: undone });
  }, [undone, target]);

  if (target === null) return null;
  const own = opened.status === "ready" && ["user", "portable"].includes(opened.item.scope);
  return (
    <Section id={OPENED_HEADING} title="Opened from a conversation">
      {opened.status === "loading" && <p role="status">Loading the memory…</p>}
      {opened.status === "gone" && (
        <Notice tone="warn">
          <p>This memory is no longer available to you.</p>
        </Notice>
      )}
      {opened.status === "ready" && (
        <>
          {!own && (
            <p className="m-0 mb-2 text-sm text-console-muted">
              Workspace and Site memories are changed by their curators.
            </p>
          )}
          <ul aria-label="Opened memory" className="m-0 flex list-none flex-col gap-2 p-0">
            <ItemRow
              item={opened.item}
              api={api}
              known={known}
              readOnly={!own}
              onChanged={(item, done) => {
                setOpened({ status: "ready", item });
                onChanged(item, done);
              }}
              onRefreshed={(item) => setOpened({ status: "ready", item })}
            />
          </ul>
        </>
      )}
    </Section>
  );
}
