"use client";

/**
 * The PDF viewer's controls (KOBE-801): page navigation with a page field and the count, zoom,
 * fit to width / fit page, and find in the document (its own row while open). Every control is
 * a labelled button or field; the keys are in the viewer (`pdf-viewer.tsx`).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { parsePageInput } from "../../lib/files/viewer";
import { IconAction } from "../shell/icon-action";
import type { PdfFind } from "./use-pdf-find";

export type ZoomMode = "fit-width" | "fit-page" | "custom";

const FIELD =
  "border-input bg-background h-7 rounded-md border px-1.5 text-center text-sm tabular-nums";

function PageField({
  page,
  count,
  onPage,
}: {
  readonly page: number;
  readonly count: number;
  onPage(page: number): void;
}) {
  const [text, setText] = useState(String(page));
  useEffect(() => setText(String(page)), [page]);
  const commit = () => {
    const next = parsePageInput(text, count);
    if (next === null) setText(String(page));
    else onPage(next);
  };
  return (
    <span className="flex items-center gap-1 text-sm">
      <input
        aria-label="Page number"
        inputMode="numeric"
        className={`${FIELD} w-12`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setText(String(page));
        }}
      />
      <span className="text-muted-foreground whitespace-nowrap">{`of ${count}`}</span>
    </span>
  );
}

export interface PdfToolbarProps {
  readonly page: number;
  readonly count: number;
  readonly scale: number;
  readonly mode: ZoomMode;
  readonly findOpen: boolean;
  onPage(page: number): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onMode(mode: "fit-width" | "fit-page"): void;
  onToggleFind(): void;
}

export function PdfToolbar(p: PdfToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="PDF controls"
      className="bg-background flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1"
    >
      <IconAction
        command="viewer-previous-page"
        size="sm"
        disabled={p.page <= 1}
        onClick={() => p.onPage(p.page - 1)}
      />
      <IconAction
        command="viewer-next-page"
        size="sm"
        disabled={p.page >= p.count}
        onClick={() => p.onPage(p.page + 1)}
      />
      <PageField page={p.page} count={p.count} onPage={p.onPage} />
      <span className="bg-border mx-1 h-5 w-px" aria-hidden="true" />
      <IconAction command="viewer-zoom-out" size="sm" shortcut="Mod+-" onClick={p.onZoomOut} />
      <output aria-label="Zoom" className="w-12 text-center text-sm tabular-nums">
        {`${Math.round(p.scale * 100)}%`}
      </output>
      <IconAction command="viewer-zoom-in" size="sm" shortcut="Mod+=" onClick={p.onZoomIn} />
      <IconAction
        command="viewer-fit-width"
        size="sm"
        shortcut="Mod+0"
        aria-pressed={p.mode === "fit-width"}
        onClick={() => p.onMode("fit-width")}
      />
      <IconAction
        command="viewer-fit-page"
        size="sm"
        aria-pressed={p.mode === "fit-page"}
        onClick={() => p.onMode("fit-page")}
      />
      <span className="flex-1" />
      <IconAction
        command="viewer-find"
        size="sm"
        shortcut="Mod+F"
        aria-pressed={p.findOpen}
        onClick={p.onToggleFind}
      />
    </div>
  );
}

function findStatus(find: PdfFind): string {
  if (find.query.trim() === "") return "";
  if (find.searching) return "Searching…";
  if (find.total === 0) return "No matches";
  return `${(find.current ?? 0) + 1} of ${find.total}`;
}

export function PdfFindBar({ find, onClose }: { readonly find: PdfFind; onClose(): void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) find.previous();
      else find.next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
  const none = find.total === 0;
  return (
    <div
      role="search"
      aria-label="Find in document"
      className="bg-background flex shrink-0 items-center gap-1 border-b px-2 py-1"
    >
      <input
        ref={input}
        type="search"
        aria-label="Find in document"
        placeholder="Find in document"
        className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-sm"
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span role="status" className="text-muted-foreground min-w-20 text-xs whitespace-nowrap">
        {findStatus(find)}
      </span>
      <IconAction
        command="viewer-find-previous"
        size="sm"
        shortcut="Shift+Enter"
        disabled={none}
        onClick={find.previous}
      />
      <IconAction
        command="viewer-find-next"
        size="sm"
        shortcut="Enter"
        disabled={none}
        onClick={find.next}
      />
      <IconAction command="viewer-find-close" size="sm" shortcut="Escape" onClick={onClose} />
    </div>
  );
}
