/**
 * pdf.js for the PDF viewer (KOBE-801), loaded only when a PDF opens. Everything it needs comes
 * from this origin: the worker, the CMaps and the no-WebAssembly image decoders are copied from
 * `pdfjs-dist` into `public/pdfjs/<version>/` before every build (`scripts/copy-pdfjs-assets.mjs`),
 * so the page CSP (`worker-src 'self'`, `connect-src 'self'`) stays as it is.
 *
 * Hardening: the file is opened from bytes already read through the audited workspace route
 * (no URL, no range requests); no PDF JavaScript runs (pdf.js only scripts documents through its
 * viewer's sandbox, which Kaiju never loads); XFA forms are off; pdf.js 6 has no `eval` path
 * left (the old `isEvalSupported` option is gone with the code behind it); WebAssembly is off,
 * as the CSP has no `'wasm-unsafe-eval'` (pdf.js uses its JavaScript decoders instead); standard
 * fonts that a file does not embed fall back to system fonts. The viewer never mounts pdf.js's
 * annotation layer: links are drawn by Kaiju (`components/files/pdf-page.tsx`).
 */
import type * as PdfJsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentInitParameters, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

export type PdfDocument = PDFDocumentProxy;

/** A document being opened: `promise` settles once; `destroy()` frees it (and its worker). */
export interface PdfLoad {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * The legacy build: the default build needs built-ins only the newest browsers have (Safari 18.2+,
 * Chrome 140+); the legacy one runs in every browser Next.js supports, for ~60 kB more.
 */
type PdfJs = typeof PdfJsModule;

/** Images larger than this (pixels) are skipped by pdf.js instead of decoded. */
export const PDF_IMAGE_MAX_PIXELS = 4096 * 4096;
/** The most pdf.js may spend on one intermediate canvas (bytes). */
export const PDF_CANVAS_MAX_BYTES = 64 * 1024 * 1024;

/** Where the copied assets are served for this pdf.js version (versioned, so caches never mix). */
export function pdfAssetsBase(version: string): string {
  return `/pdfjs/${version}/`;
}

/** The options every document is opened with (exported for the test). */
export function documentOptions(bytes: Uint8Array, base: string): DocumentInitParameters {
  return {
    // pdf.js transfers the buffer to its worker: hand it a copy, the tab keeps its own bytes.
    data: bytes.slice(),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${base}wasm/`,
    useWasm: false,
    useSystemFonts: true,
    enableXfa: false,
    disableWorkerRendering: true,
    // A damaged file shows what pdf.js can read of it rather than failing whole.
    stopAtErrors: false,
    // Decompression bombs: images over 16 megapixels are dropped (the page draws without them),
    // and pdf.js's intermediate canvases stay under 64 MiB.
    maxImageSize: PDF_IMAGE_MAX_PIXELS,
    canvasMaxAreaInBytes: PDF_CANVAS_MAX_BYTES,
    // Errors only: a damaged-but-readable file should not flood the console.
    verbosity: 0,
  };
}

let loading: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${pdfAssetsBase(lib.version)}pdf.worker.min.mjs`;
    return lib;
  });
  // A failed load (offline, a new build's assets) may succeed when the next PDF opens.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Opens `bytes` as a PDF; a password-protected file rejects with pdf.js's PasswordException. */
export function openPdf(bytes: Uint8Array): PdfLoad {
  let destroyed = false;
  let task: { destroy(): Promise<void> } | null = null;
  const promise = loadPdfJs().then((lib) => {
    if (destroyed) throw new Error("The PDF was closed while it opened.");
    // No `onPassword`: pdf.js then rejects with PasswordException instead of asking.
    const t = lib.getDocument(documentOptions(bytes, pdfAssetsBase(lib.version)));
    task = t;
    return t.promise;
  });
  return {
    promise,
    destroy: async () => {
      destroyed = true;
      await task?.destroy();
    },
  };
}

/** pdf.js's text layer (transparent, selectable spans over the canvas), one per rendered page. */
export interface TextLayerHandle {
  render(): Promise<unknown>;
  cancel(): void;
  readonly textDivs: readonly HTMLElement[];
}

export type TextLayerParams = ConstructorParameters<PdfJs["TextLayer"]>[0];

export async function createTextLayer(params: TextLayerParams): Promise<TextLayerHandle> {
  const lib = await loadPdfJs();
  return new lib.TextLayer(params);
}
