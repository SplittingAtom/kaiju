/**
 * Pure helpers of the file viewers (KOBE-801 PDF, KOBE-807 images): zoom steps and fit scales,
 * page numbers, find in a PDF's text items, the link rule for links inside a PDF, and how a
 * pdf.js failure is told to the member.
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;
/** Floats from fit modes are compared with this slack, so 1.0000001 steps to 1.1, not 1. */
const EPSILON = 1e-3;

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function zoomIn(scale: number): number {
  return ZOOM_STEPS.find((s) => s > scale + EPSILON) ?? ZOOM_MAX;
}

export function zoomOut(scale: number): number {
  return [...ZOOM_STEPS].reverse().find((s) => s < scale - EPSILON) ?? ZOOM_MIN;
}

export type ViewerKey = "find" | "zoom-in" | "zoom-out" | "fit";

/** The viewers' keys (KOBE-801, KOBE-807): Mod+F, Mod+= (or +), Mod+-, Mod+0. */
export function viewerKey(e: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): ViewerKey | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  switch (e.key) {
    case "f":
    case "F":
      return "find";
    case "=":
    case "+":
      return "zoom-in";
    case "-":
      return "zoom-out";
    case "0":
      return "fit";
    default:
      return null;
  }
}

export type FitMode = "fit-width" | "fit-page";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The scale that fits `page` (CSS pixels at 100%) into `box`, less `padding` on each axis. */
export function fitScale(mode: FitMode, page: Size, box: Size, padding: number): number {
  if (page.width <= 0 || page.height <= 0) return 1;
  const byWidth = (box.width - padding) / page.width;
  const scale =
    mode === "fit-width" ? byWidth : Math.min(byWidth, (box.height - padding) / page.height);
  return clampZoom(Number.isFinite(scale) ? scale : 1);
}

export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, count), Math.max(1, Math.trunc(page)));
}

/** A page number typed into the page field, clamped; null when it is not a whole number. */
export function parsePageInput(text: string, count: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return clampPage(Number(trimmed), count);
}

export interface TextPosition {
  readonly item: number;
  readonly offset: number;
}

export interface TextMatch {
  readonly start: TextPosition;
  /** Exclusive. */
  readonly end: TextPosition;
}

/** Where `offset` of the joined text falls among the items. */
function position(starts: readonly number[], offset: number): TextPosition {
  let item = 0;
  while (item + 1 < starts.length && (starts[item + 1] ?? Infinity) <= offset) item += 1;
  return { item, offset: offset - (starts[item] ?? 0) };
}

/**
 * Case-insensitive matches of `query` in a page's text items (pdf.js text content, one item per
 * text-layer span), which are joined without separators as pdf.js's own find does.
 */
export function findInItems(items: readonly string[], query: string): TextMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const starts: number[] = [];
  let joined = "";
  for (const item of items) {
    starts.push(joined.length);
    joined += item;
  }
  const haystack = joined.toLowerCase();
  const matches: TextMatch[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const end = position(starts, at + needle.length - 1);
    matches.push({ start: position(starts, at), end: { item: end.item, offset: end.offset + 1 } });
    if (matches.length >= 10_000) break;
  }
  return matches;
}

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * A link inside a PDF as the chat renders links (`components/chat/markdown.tsx`): absolute
 * `http:`, `https:` and `mailto:` only, opened in a new tab; anything else stays inert.
 */
export function safeLinkUrl(url: unknown): string | null {
  if (typeof url !== "string" || !URL.canParse(url)) return null;
  return SAFE_PROTOCOLS.has(new URL(url).protocol) ? url : null;
}

export type PdfErrorKind = "password" | "invalid" | "other";

/** pdf.js names its exceptions; a password-protected file and a broken one get their own text. */
export function pdfErrorKind(error: unknown): PdfErrorKind {
  const name =
    error !== null && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (name === "PasswordException") return "password";
  if (name === "InvalidPDFException" || name === "FormatError") return "invalid";
  return "other";
}

/** Browsers refuse canvases much past 16 megapixels (Safari's limit); stay under it. */
const CANVAS_MAX_PIXELS = 16_777_216;

/** Canvas pixels per CSS pixel for a page of `width`×`height` CSS pixels. */
export function canvasOutputScale(width: number, height: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = width * height * ratio * ratio;
  return area <= CANVAS_MAX_PIXELS ? ratio : ratio * Math.sqrt(CANVAS_MAX_PIXELS / area);
}
