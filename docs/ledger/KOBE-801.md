# KOBE-801: Centre panel: display PDF files

- **Status:** in review (group 83, branch `group-83-pdf-and-viewers`, no PR yet)
- **Branch / worktree:** `group-83-pdf-and-viewers` in `../Kobe-g83`
- **Depends on:** none

## Plan

`pdf` preview kind (25 MB cap) in `lib/files/preview.ts`; `FileBody` reads the whole file through
the audited `GET /v1/workspace/file` and hands the bytes to a lazily loaded viewer
(`components/files/pdf-viewer.tsx`, `pdf-page.tsx`, `pdf-toolbar.tsx`, `use-pdf-find.ts`), with
pdf.js behind one module (`lib/files/pdfjs.ts`) that the component tests mock.

## Decisions

- **pdf.js `pdfjs-dist` 6.5.438, legacy build.** The default build needs `Uint8Array.toHex` and
  other built-ins only Safari 18.2+/Chrome 140+ have (it failed under Node 24 in the test); the
  legacy build covers every browser Next.js supports for ~60 kB more (lazy chunk ~500 kB raw,
  worker 1.3 MB, both loaded only when a PDF opens; the viewer chunk is ~13 kB).
- **Worker from the app's origin, CSP untouched.** `scripts/copy-pdfjs-assets.mjs` runs before
  `next build`/`next dev` and copies the legacy worker, the CMaps (BSD-3, Adobe) and the
  no-WebAssembly JPEG 2000/JBIG2 decoders (BSD-2 OpenJPEG, BSD-3 PDFium, Apache-2.0 pdf.js) with
  their licence files into `public/pdfjs/<version>/` (gitignored, versioned path). The web
  Dockerfile already copies `public/` after the build. Checked on the standalone output:
  `/pdfjs/6.5.438/pdf.worker.min.mjs` is served `200`, `application/javascript`, nosniff, with the
  page CSP; `worker-src 'self'` allows it. The worker fetches CMaps under `connect-src 'self'`.
- **Hardening.** Bytes, never a URL (no range requests); `enableXfa: false`; no scripting (pdf.js
  scripts PDFs only through its viewer's sandbox, which Kobe never loads; `pdf.sandbox`/QuickJS
  are not copied); `isEvalSupported` no longer exists in pdf.js 6 together with the eval code it
  guarded (no `new Function`/`eval(` in the builds, grep); `useWasm: false` since the CSP has no
  `'wasm-unsafe-eval'` (JS decoders used); standard fonts not shipped (system fonts stand in, so
  no font licence questions and no fetch); `disableWorkerRendering: true` (one worker, no
  OffscreenCanvas renderer worker). pdf.js's annotation layer is never mounted: Kobe draws links
  itself with the chat's rule (`http`/`https`/`mailto` only, new tab, `noopener noreferrer
nofollow`); internal destinations jump to their page; anything else is inert.
- **`@napi-rs/canvas`** (pdfjs-dist's optional native canvas for Node) is in
  `ignoredOptionalDependencies`: the viewer runs only in the browser.
- **Find:** case-insensitive over pdf.js text items (the same items the text layer draws), whole
  spans highlighted, current match centred. **Virtualisation:** page tops computed from sizes
  (page 1's size until a page is read), only pages within one screen of the view are rendered;
  leaving the window frees the canvas and text layer; closing the tab or loading another file
  destroys the document and its worker.
- **Artifacts:** no `pdf` artifact kind. Artifacts are UTF-8 text by protocol
  (`ARTIFACT_KINDS` html/svg/markdown/mermaid/code/csv, content as text), so agents cannot make a
  PDF artifact today; they write `.pdf` files (ReportLab/pypdf are in the sandbox) and
  `open_file` them, which this viewer shows. A binary artifact kind would be a protocol change of
  its own.
- **Attachments and projects** are workspace paths (`uploads/<thread>/`, `projects/<slug>/`) and
  open through the same `FileTabContent`; covered in `file-viewer.test.tsx`.

## Docs

`docs/guide/files/file-editor.md` (What opens how, The PDF viewer), keyboard shortcuts page (viewer
keys), `for-agents/working-in-a-sandbox.md` (what the user's viewer shows; hand over a PDF by
writing and opening it). The glossary needed no PDF entry.

## Open questions (for Chris or the coordinator)

- None blocking. The browser spec `e2e/browser/tests/pdf-viewer.spec.ts` cannot run here (no
  deployment from this worktree); run it after the next gate1 deploy.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/files/file-viewer.test.tsx` "PDFs open in the PDF viewer from Files, a project
  and a thread upload"; artifacts: see Decisions.
- ac-2: `components/files/pdf-viewer.test.tsx` (pages, lazy rendering, next/previous/page field,
  zoom/fit by mouse and keys, find with Mod+F/Enter/Shift+Enter/Escape, links, memory).
- ac-3: `lib/files/pdfjs.test.ts` (options: no URL, no WebAssembly, no XFA, same-origin asset
  base); standalone build check above; browser spec asserts no CSP console errors.
- ac-4: `pdf-viewer.test.tsx` password/broken; `pdfjs.test.ts` real pdf.js on a password-protected
  and a broken file; `file-viewer.test.tsx` "PDFs over 25 MB are not fetched".
- ac-5: tests above, browser spec, guide pages, `THIRD_PARTY_LICENSES.md` regenerated
  (`pnpm licenses:update`; `pnpm license:check` green).
