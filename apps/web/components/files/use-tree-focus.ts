"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { TreeFocus } from "./file-tree";

type Which = "projects" | "mine";

/**
 * Focus across the rail's two trees (Projects, My files). Two trees report focus; only the one
 * holding the focus (DOM focus moved into it last) sets the Upload target and the folder note;
 * the other's reports are kept for when it is entered. `focusRow` asks a tree to focus a row.
 */
export function useTreeFocus() {
  const [focus, setFocus] = useState<TreeFocus>({ path: null, folder: "" });
  const [focusRequest, setFocusRequest] = useState<{ path: string; seq: number } | null>(null);
  const focusSource = useRef<Which>("mine");
  const lastFocus = useRef<Record<Which, TreeFocus>>({
    projects: { path: null, folder: "" },
    mine: { path: null, folder: "" },
  });
  const focusFrom = useMemo(() => {
    const from = (which: Which) => (next: TreeFocus) => {
      lastFocus.current[which] = next;
      if (focusSource.current === which) setFocus(next);
    };
    return { projects: from("projects"), mine: from("mine") };
  }, []);
  const enterTree = (which: Which) => () => {
    if (focusSource.current === which) return;
    focusSource.current = which;
    setFocus(lastFocus.current[which]);
  };
  const focusRow = useCallback(
    (path: string) => setFocusRequest((prev) => ({ path, seq: (prev?.seq ?? 0) + 1 })),
    [],
  );
  return { focus, focusRequest, focusFrom, enterTree, focusRow };
}
