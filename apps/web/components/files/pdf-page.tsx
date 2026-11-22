"use client";

/**
 * One page of the PDF viewer (KOBE-801). Off screen it is an empty box of the page's size; on
 * screen (`active`) it renders its canvas, pdf.js's text layer (select, copy, find highlights)
 * and Kobe's own link layer: web and mail links open like the chat's links (new tab,
 * `noopener noreferrer nofollow`), links inside the document jump to their page, anything else
 * (`javascript:`, `file:`, launch actions) is not drawn. Leaving the screen frees the canvas.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createTextLayer, type PdfDocument } from "../../lib/files/pdfjs";
import { canvasOutputScale, safeLinkUrl, type Size, type TextMatch } from "../../lib/files/viewer";
import styles from "./viewer.module.css";

/** pdf.js page units are points (1/72 in); 100 % shows them at CSS size (1/96 in). */
export const PDF_TO_CSS = 96 / 72;

interface LinkBox {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly url: string | null;
  readonly dest: unknown;
}

interface Annotation {
  readonly id?: string;
  readonly subtype?: string;
  readonly rect?: readonly number[];
  readonly url?: unknown;
  readonly dest?: unknown;
}

type Viewport = ReturnType<Awaited<ReturnType<PdfDocument["getPage"]>>["getViewport"]>;

function linkBoxes(annotations: readonly Annotation[], viewport: Viewport): LinkBox[] {
  const boxes: LinkBox[] = [];
  annotations.forEach((a, i) => {
    if (a.subtype !== "Link" || !a.rect || a.rect.length !== 4) return;
    const url = safeLinkUrl(a.url);
    const dest = a.dest ?? null;
    if (url === null && dest === null) return; // inert: nothing Kobe will follow
    const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = a.rect;
    const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(r0, r1) as number[];
    const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(r2, r3) as number[];
    boxes.push({
      key: a.id ?? String(i),
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      url,
      dest: url === null ? dest : null,
    });
  });
  return boxes;
}

const isCancel = (e: unknown) =>
  e !== null &&
  typeof e === "object" &&
  ["RenderingCancelledException", "AbortException"].includes(
    String((e as { name?: unknown }).name),
  );

export interface PdfPageProps {
  readonly doc: PdfDocument;
  readonly number: number;
  readonly count: number;
  /** The zoom (1 = 100 %). */
  readonly scale: number;
  /** The page's size at 100 % in CSS pixels (an estimate until the page itself is read). */
  readonly size: Size;
  /** On screen or close to it: render it. */
  readonly active: boolean;
  /** Find matches on this page, and which of them is the current one. */
  readonly matches: readonly TextMatch[];
  readonly selected: number | null;
  onSize(page: number, size: Size): void;
  onInternalLink(dest: unknown): void;
}

/** Marks the text-layer spans that hold each match; scrolls the current one into view. */
function useHighlights(
  divs: readonly HTMLElement[],
  matches: readonly TextMatch[],
  selected: number | null,
) {
  useEffect(() => {
    const marked: HTMLElement[] = [];
    matches.forEach((m, i) => {
      for (let item = m.start.item; item <= m.end.item; item++) {
        const div = divs[item];
        if (!div) continue;
        div.classList.add(styles.match ?? "match");
        if (i === selected) div.classList.add(styles.matchSelected ?? "matchSelected");
        marked.push(div);
      }
    });
    if (selected !== null) {
      const first = divs[matches[selected]?.start.item ?? -1];
      first?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
    return () => {
      for (const div of marked) {
        div.classList.remove(styles.match ?? "match", styles.matchSelected ?? "matchSelected");
      }
    };
  }, [divs, matches, selected]);
}

export function PdfPage({
  doc,
  number,
  count,
  scale,
  size,
  active,
  matches,
  selected,
  onSize,
  onInternalLink,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<readonly LinkBox[]>([]);
  const [divs, setDivs] = useState<readonly HTMLElement[]>([]);
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let renderTask: { cancel(): void } | null = null;
    let textLayer: { cancel(): void } | null = null;
    const run = async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: PDF_TO_CSS });
      onSize(number, { width: base.width, height: base.height });
      const viewport = page.getViewport({ scale: scale * PDF_TO_CSS });
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!canvas || !textDiv) return;
      const ratio = canvasOutputScale(viewport.width, viewport.height, window.devicePixelRatio);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;
      setDrawn(true);
      const textContent = await page.getTextContent();
      if (cancelled) return;
      textDiv.replaceChildren();
      const layer = await createTextLayer({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      });
      textLayer = layer;
      if (cancelled) return layer.cancel();
      await layer.render();
      if (cancelled) return;
      setDivs(layer.textDivs);
      const annotations = (await page.getAnnotations({ intent: "display" })) as Annotation[];
      if (!cancelled) setLinks(linkBoxes(annotations, viewport));
    };
    run().catch((e: unknown) => {
      if (!cancelled && !isCancel(e)) setFailed(true);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, number, scale, active, onSize]);

  // Off screen (or closed): give the canvas memory and the text layer's nodes back.
  useEffect(() => {
    if (active) return;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    textRef.current?.replaceChildren();
    setDivs([]);
    setLinks([]);
    setDrawn(false);
  }, [active]);
  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    [],
  );

  useHighlights(divs, matches, selected);

  const width = Math.floor(size.width * scale);
  const height = Math.floor(size.height * scale);
  const style = { width, height, "--scale-factor": scale * PDF_TO_CSS } as CSSProperties;
  return (
    <div
      role="group"
      aria-label={`Page ${number} of ${count}`}
      data-pdf-page={number}
      data-rendered={active && drawn ? "true" : undefined}
      className={styles.page}
      style={style}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div ref={textRef} className="textLayer" />
      {links.length > 0 && (
        <div className={styles.links}>
          {links.map((l) => {
            const box = { left: l.left, top: l.top, width: l.width, height: l.height };
            return l.url !== null ? (
              <a
                key={l.key}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title={l.url}
                aria-label={`Link: ${l.url}`}
                style={box}
              />
            ) : (
              <button
                key={l.key}
                type="button"
                aria-label="Go to the linked place in this document"
                style={box}
                onClick={() => onInternalLink(l.dest)}
              />
            );
          })}
        </div>
      )}
      {failed && (
        <p
          role="status"
          className={`${styles.pageNote} absolute inset-x-0 top-4 text-center text-sm`}
        >
          {`Page ${number} could not be shown.`}
        </p>
      )}
    </div>
  );
}
