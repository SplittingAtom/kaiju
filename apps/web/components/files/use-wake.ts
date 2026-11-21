"use client";

import { useEffect, useRef, useState } from "react";
import type { FilesApi } from "../../lib/files/api";
import type { WorkspaceEventFeed, WorkspaceMoved } from "../../lib/files/workspace-events";

/**
 * Wakes the sandbox on mount, listing again after its first sync; tracks "last synced" until that
 * refresh. Each later `key` (Refresh, Show files: the member asked for the files again) is a sync
 * now (KOBE-599): the running sandbox pushes first, then everything on screen lists again
 * (`relist`); `syncing` meanwhile. A sandbox that was asleep is woken by the server and listed
 * again once more after its first sync.
 */
export function useWake(
  api: FilesApi,
  relist: () => void,
  refreshMs: number,
  key: number,
): { readonly waking: boolean; readonly syncing: boolean } {
  const [doneKey, setDoneKey] = useState<number | null>(null);
  const [syncedKey, setSyncedKey] = useState<number | null>(null);
  const mounted = useRef(false);
  const firstKey = useRef(key);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      timer = setTimeout(() => {
        relist();
        setDoneKey(key);
      }, refreshMs);
    };
    if (!mounted.current) {
      // The first listing is the tree's own.
      mounted.current = true;
      void api.wake().then((res) => {
        if (!current) return;
        if (!res.ok) return setDoneKey(key);
        later();
      });
    } else {
      void api.syncNow().then((res) => {
        if (!current) return;
        relist();
        setSyncedKey(key);
        if (res.ok && res.data.status === "asleep") later();
        else setDoneKey(key);
      });
    }
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // relist is stable; the wake or sync runs once per ask.
  }, [api, refreshMs, key]);
  return {
    // The first wake, or a Refresh that found the sandbox asleep, until its first sync is listed.
    waking: doneKey !== key && (key === firstKey.current || syncedKey === key),
    syncing: key !== firstKey.current && syncedKey !== key,
  };
}

/**
 * Lists again whenever the workspace says something changed (KOBE-599): a sandbox push, an
 * upload in another tab, a project commit. Debounced by the feed; open folders stay open.
 */
export function useWorkspaceEvents(
  events: WorkspaceEventFeed | undefined,
  onMoved: (moved: WorkspaceMoved) => void,
): void {
  const latest = useRef(onMoved);
  latest.current = onMoved;
  useEffect(() => events?.subscribe((moved) => latest.current(moved)), [events]);
}
