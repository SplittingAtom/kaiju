"use client";

/**
 * The image viewer of a file tab (KOBE-807), for PNG, JPEG, GIF, WebP and SVG: the image stays an
 * `<img>` from a `data:` URL (SVG is never inlined, so its scripts never run), over a
 * checkerboard that shows transparency, on the viewers' dark surround. Controls: zoom in and out,
 * fit to width (the default; a small image stays at its actual size) and actual size, with the
 * pixel dimensions and the file size. When the image is larger than the column, drag to pan
 * (the arrow keys scroll too, once focused). Keys inside: Mod+= / Mod+- zoom, Mod+0 fit.
 */
import { useRef, useState, type PointerEvent } from "react";
import { formatBytes } from "../../lib/files/format";
import { fitScale, viewerKey, zoomIn, zoomOut, type Size } from "../../lib/files/viewer";
import { IconAction } from "../shell/icon-action";
import { useBoxSize } from "./use-box-size";
import styles from "./viewer.module.css";

type Mode = "fit" | "actual" | "custom";

/** Space around the image, in CSS pixels. */
const PAD = 12;
/** An image without an intrinsic size (some SVGs) lays out like the browser's default box. */
const NO_SIZE: Size = { width: 300, height: 150 };

function useDragPan() {
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: el.scrollLeft,
        top: el.scrollTop,
      };
      el.setPointerCapture?.(e.pointerId);
      setPanning(true);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
      e.currentTarget.scrollTop = d.top - (e.clientY - d.y);
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== e.pointerId) return;
      drag.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setPanning(false);
    },
  };
  return { panning, handlers: { ...handlers, onPointerCancel: handlers.onPointerUp } };
}

export function ImageViewer({
  src,
  name,
  size,
}: {
  readonly src: string;
  readonly name: string;
  /** The file's size in bytes. */
  readonly size: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const box = useBoxSize(scroller);
  const [natural, setNatural] = useState<Size | null>(null);
  const [mode, setMode] = useState<Mode>("fit");
  const [custom, setCustom] = useState(1);
  const { panning, handlers } = useDragPan();

  const image = natural ?? NO_SIZE;
  const fit = box.width > 0 ? Math.min(1, fitScale("fit-width", image, box, PAD * 2)) : 1;
  const scale = mode === "fit" ? fit : mode === "actual" ? 1 : custom;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const pannable = width + PAD * 2 > box.width || height + PAD * 2 > box.height;

  const zoom = (next: number) => {
    setCustom(next);
    setMode("custom");
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = viewerKey(e);
    if (key === null || key === "find") return;
    e.preventDefault();
    if (key === "zoom-in") zoom(zoomIn(scale));
    else if (key === "zoom-out") zoom(zoomOut(scale));
    else setMode("fit");
  };
  const facts = [
    natural ? `${natural.width} × ${natural.height} px` : null,
    formatBytes(size),
  ].filter(Boolean);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div
        role="toolbar"
        aria-label="Image controls"
        className="bg-background flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1"
      >
        <IconAction
          command="viewer-zoom-out"
          size="sm"
          shortcut="Mod+-"
          onClick={() => zoom(zoomOut(scale))}
        />
        <output aria-label="Zoom" className="w-12 text-center text-sm tabular-nums">
          {`${Math.round(scale * 100)}%`}
        </output>
        <IconAction
          command="viewer-zoom-in"
          size="sm"
          shortcut="Mod+="
          onClick={() => zoom(zoomIn(scale))}
        />
        <IconAction
          command="viewer-fit-width"
          size="sm"
          shortcut="Mod+0"
          aria-pressed={mode === "fit"}
          onClick={() => setMode("fit")}
        />
        <IconAction
          command="viewer-actual-size"
          size="sm"
          aria-pressed={mode === "actual"}
          onClick={() => setMode("actual")}
        />
        <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap tabular-nums">
          {facts.join(" · ")}
        </span>
      </div>
      <div
        ref={scroller}
        role="region"
        aria-label={name}
        // Scrolls (and pans) with the keyboard once focused.
        tabIndex={0}
        className={`${styles.surround} ${pannable ? (panning ? styles.panning : styles.pannable) : ""} min-h-0 flex-1 touch-none overflow-auto outline-none select-none focus-visible:ring-2 focus-visible:ring-inset`}
        {...(pannable ? handlers : {})}
      >
        <div className="grid h-max min-h-full w-max min-w-full place-items-center p-3">
          <div className={styles.checkerboard}>
            <img
              src={src}
              alt={name}
              draggable={false}
              className="block max-w-none"
              style={{ width, height }}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                setNatural(w > 0 && h > 0 ? { width: w, height: h } : null);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
