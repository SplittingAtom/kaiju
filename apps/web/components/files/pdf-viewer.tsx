"use client";

/**
 * The PDF viewer of a file tab (KOBE-801), loaded only when a PDF opens. pdf.js renders each page
 * to a canvas inside the page (no `<embed>`/`<object>`, no CSP change; `lib/files/pdfjs.ts`):
 * only pages on screen or next to it are rendered, the rest are empty boxes of the right size.
 * Controls: previous/next page, the page field and count, zoom, fit to width (the default) or
 * fit page, which follow the column's size, find in the document, and text selection. Keys,
 * inside the viewer: Mod+F find, Mod+= / Mod+- zoom, Mod+0 fit to width; Page Up/Down, the
 * arrows, Home and End scroll the pages. Closing the tab, or another file, frees the document
 * and its worker. A password-protected or unreadable file says so, with Download.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openPdf, type PdfDocument } from "../../lib/files/pdfjs";
import {
  clampPage,
  fitScale,
  pdfErrorKind,
  viewerKey,
  zoomIn,
  zoomOut,
  type PdfErrorKind,
  type Size,
} from "../../lib/files/viewer";
import { CannotPreview } from "./cannot-preview";
import { PDF_TO_CSS, PdfPage } from "./pdf-page";
import { PdfFindBar, PdfToolbar, type ZoomMode } from "./pdf-toolbar";
import { useBoxSize } from "./use-box-size";
import { usePdfFind } from "./use-pdf-find";
import styles from "./viewer.module.css";

/** Space around and between pages, in CSS pixels. */
const PAD = 12;
/** Pages within this many screen heights above and below the view are rendered. */
const RENDER_MARGIN = 1;
/** Pages beyond the rendered window that stay mounted (as empty boxes) on each side. */
const MOUNT_EXTRA = 1;
/**
 * The most pages the viewer lays out (KOBE-801 review): a hostile file can declare hundreds of
 * thousands of tiny pages. Past it, the first pages show with a note and Download.
 */
export const PDF_PAGE_MAX = 2000;
/** A US Letter page until the first page is read. */
const LETTER: Size = { width: 612 * PDF_TO_CSS, height: 792 * PDF_TO_CSS };

const ERRORS: Readonly<Record<PdfErrorKind, string>> = {
  password: "This PDF is password-protected, so it cannot be previewed.",
  invalid: "This file could not be read as a PDF (it may be damaged).",
  other: "This PDF could not be opened.",
};

type Load =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly doc: PdfDocument }
  | { readonly status: "error"; readonly kind: PdfErrorKind };

function usePdfDocument(bytes: Uint8Array): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    const opening = openPdf(bytes);
    opening.promise.then(
      (doc) => current && setLoad({ status: "ready", doc }),
      (e: unknown) => current && setLoad({ status: "error", kind: pdfErrorKind(e) }),
    );
    return () => {
      current = false;
      void opening.destroy();
    };
  }, [bytes]);
  return load;
}

/** Each page's top edge at `scale`, plus the total height. */
function layout(count: number, sizes: ReadonlyMap<number, Size>, base: Size, scale: number) {
  const tops: number[] = [];
  let y = PAD;
  for (let page = 1; page <= count; page++) {
    tops.push(y);
    y += Math.floor((sizes.get(page) ?? base).height * scale) + PAD;
  }
  return { tops, height: y };
}

/** The last page whose top is above `y` (binary search over the sorted tops). */
function pageAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((tops[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function Viewer({
  doc,
  name,
  onDownload,
}: {
  readonly doc: PdfDocument;
  readonly name: string;
  onDownload?: (() => void) | undefined;
}) {
  const count = Math.min(doc.numPages, PDF_PAGE_MAX);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useBoxSize(scroller);
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(new Map());
  const [mode, setMode] = useState<ZoomMode>("fit-width");
  const [custom, setCustom] = useState(1);
  const [page, setPage] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const find = usePdfFind(doc, count);

  const base = sizes.get(1) ?? LETTER;
  const scale = mode === "custom" ? custom : fitScale(mode, sizes.get(page) ?? base, box, PAD * 2);
  const { tops, height } = useMemo(
    () => layout(count, sizes, base, scale),
    [count, sizes, base, scale],
  );

  const onSize = useCallback((n: number, size: Size) => {
    setSizes((prev) => {
      const old = prev.get(n);
      if (old && Math.abs(old.width - size.width) < 0.5 && Math.abs(old.height - size.height) < 0.5)
        return prev;
      return new Map(prev).set(n, size);
    });
  }, []);

  const goTo = useCallback(
    (n: number) => {
      const target = clampPage(n, count);
      setPage(target);
      const top = (tops[target - 1] ?? PAD) - PAD;
      setScrollTop(top);
      const el = scroller.current;
      if (el) el.scrollTop = top;
    },
    [count, tops],
  );

  // Zooming keeps the current page in view.
  const anchor = useRef({ page: 1, scale });
  useLayoutEffect(() => {
    if (anchor.current.scale === scale) return;
    anchor.current = { page, scale };
    const el = scroller.current;
    if (el) el.scrollTop = (tops[page - 1] ?? PAD) - PAD;
  }, [scale, page, tops]);

  // Scroll state at most once a frame: the window of mounted pages follows it.
  const frame = useRef<number | null>(null);
  const tick = useRef(() => {});
  tick.current = () => {
    frame.current = null;
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setPage(pageAt(tops, el.scrollTop + el.clientHeight / 3));
  };
  const onScroll = () => {
    frame.current ??= requestAnimationFrame(() => tick.current());
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // The current find match's page comes into view (its span scrolls itself to the centre).
  const hit = find.hit;
  useEffect(() => {
    if (hit) goTo(hit.page);
    // Only when the match changes, not when the layout does.
  }, [hit?.page, hit?.index]);

  const onInternalLink = useCallback(
    (dest: unknown) => {
      void (async () => {
        const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit.length === 0) return;
        const ref: unknown = explicit[0];
        const index =
          typeof ref === "number"
            ? ref
            : await doc.getPageIndex(ref as Parameters<PdfDocument["getPageIndex"]>[0]);
        goTo(index + 1);
      })().catch(() => {});
    },
    [doc, goTo],
  );

  const zoom = (next: number) => {
    setCustom(next);
    setMode("custom");
  };
  const openFind = () => setFindOpen(true);
  const closeFind = () => {
    setFindOpen(false);
    find.clear();
    scroller.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = viewerKey(e);
    if (key === null) return;
    e.preventDefault();
    if (key === "find") openFind();
    else if (key === "zoom-in") zoom(zoomIn(scale));
    else if (key === "zoom-out") zoom(zoomOut(scale));
    else setMode("fit-width");
  };

  const view = box.height > 0 ? box.height : 0;
  const first = pageAt(tops, scrollTop - view * RENDER_MARGIN);
  const last = pageAt(tops, scrollTop + view * (1 + RENDER_MARGIN));
  const isActive = (n: number) => (n >= first - 1 && n <= last + 1) || Math.abs(n - page) <= 1;
  // Only pages in (or next to) the window exist in the DOM; the tops keep the scroll height.
  const mounted: number[] = [];
  for (
    let n = Math.max(1, first - 1 - MOUNT_EXTRA);
    n <= Math.min(count, last + 1 + MOUNT_EXTRA);
    n++
  )
    mounted.push(n);
  for (const n of [page - 1, page, page + 1])
    if (n >= 1 && n <= count && !mounted.includes(n)) mounted.push(n);
  const widest = Math.max(base.width, ...[...sizes.values()].map((s) => s.width));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <PdfToolbar
        page={page}
        count={count}
        scale={scale}
        mode={mode}
        findOpen={findOpen}
        onPage={goTo}
        onZoomIn={() => zoom(zoomIn(scale))}
        onZoomOut={() => zoom(zoomOut(scale))}
        onMode={setMode}
        onToggleFind={() => (findOpen ? closeFind() : openFind())}
      />
      {findOpen && <PdfFindBar find={find} onClose={closeFind} />}
      {doc.numPages > count && (
        <div className="bg-background shrink-0 border-b px-3 py-2">
          <CannotPreview
            reason={`Showing the first ${count.toLocaleString("en-US")} of ${doc.numPages.toLocaleString("en-US")} pages.`}
            onDownload={onDownload}
          />
        </div>
      )}
      <div
        ref={scroller}
        role="region"
        aria-label={`${name}, page ${page} of ${count}`}
        // The pages scroll with the keyboard once focused.
        tabIndex={0}
        className={`${styles.surround} relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset`}
        onScroll={onScroll}
      >
        <div
          className="relative min-w-full"
          style={{ height, width: Math.floor(widest * scale) + PAD * 2 }}
        >
          {mounted.map((n) => {
            const top = tops[n - 1] ?? PAD;
            return (
              <div key={n} className="absolute inset-x-0" style={{ top }}>
                <PdfPage
                  doc={doc}
                  number={n}
                  count={count}
                  scale={scale}
                  size={sizes.get(n) ?? base}
                  active={isActive(n)}
                  matches={find.matchesOn(n)}
                  selected={find.selectedOn(n)}
                  onSize={onSize}
                  onInternalLink={onInternalLink}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function PdfViewer({
  bytes,
  name,
  onDownload,
}: {
  readonly bytes: Uint8Array;
  readonly name: string;
  onDownload?(): void;
}) {
  const load = usePdfDocument(bytes);
  if (load.status === "loading") return <p role="status">Opening the PDF…</p>;
  if (load.status === "error") {
    return <CannotPreview reason={ERRORS[load.kind]} onDownload={onDownload} />;
  }
  return <Viewer doc={load.doc} name={name} onDownload={onDownload} />;
}
