"use client";

import { useMemo, useState } from "react";
import type { ThreadFileLinks } from "../../lib/threads/file-links";
import { pinKey } from "./file-map-layer";
import type { ThreadFileMapValue } from "./thread-file-row";

/**
 * The thread–file map's shared state (KOBE-612): the pinned lines and what a row or a file does
 * (a file opens in the artifact column, then the panel closes).
 */
export function useThreadFileMapValue(
  threeRails: boolean,
  links: ReadonlyMap<string, ThreadFileLinks>,
  openPanelFile: ((path: string) => void) | undefined,
  onClose: (() => void) | undefined,
) {
  const [pins, setPins] = useState<ReadonlySet<string>>(new Set());
  const fileMap = useMemo<ThreadFileMapValue>(
    () => ({
      lines: threeRails,
      linksOf: (id) => links.get(id),
      isPinned: (side, key) => pins.has(pinKey(side, key)),
      togglePin: (side, key) =>
        setPins((prev) => {
          const next = new Set(prev);
          const k = pinKey(side, key);
          if (!next.delete(k)) next.add(k);
          return next;
        }),
      openFile: (path) => {
        openPanelFile?.(path);
        onClose?.();
      },
    }),
    [threeRails, links, pins, openPanelFile, onClose],
  );
  return { pins, fileMap };
}
