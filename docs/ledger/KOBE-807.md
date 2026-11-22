# KOBE-807: Centre panel viewers: image zoom and fit; glossary names the column correctly

- **Status:** in review (group 83, branch `group-83-pdf-and-viewers`, no PR yet)
- **Branch / worktree:** `group-83-pdf-and-viewers` in `../Kobe-g83`
- **Depends on:** KOBE-801 (same branch: shared viewer helpers, commands, CSS, `CannotPreview`)

## Plan

`components/files/image-viewer.tsx` replaces the bare `<img className="max-w-full">` for images and
SVG; `previewLimit` / `tooLargeMessage` / `cutTextMessage` in `lib/files/preview.ts` word every
"too large" note the same way; the guide stops calling the artifact column the right-hand one.

## Decisions

- **Image viewer:** the image stays an `<img>` from a `data:` URL (SVG never inlined; CSP
  `img-src 'self' data:` unchanged), over a CSS checkerboard on the viewers' dark surround.
  Toolbar: Zoom out / level / Zoom in, Fit to width (default; never upscales a small image, so a
  16 px icon is not blown up) and Actual size (both `aria-pressed`), then "W × H px · size".
  Pan: pointer drag (pointer capture) when the image is larger than the column; the focused region
  scrolls with the arrow keys. Keys Mod+= / Mod+- / Mod+0 shared with the PDF viewer
  (`viewerKey` in `lib/files/viewer.ts`). An SVG without an intrinsic size shows no dimensions
  and lays out at 300 × 150 (the browser default) until zoomed.
- **Large-file notes:** "This file is too large to preview (12 MB). Images over 10 MB are not
  previewed. Use Download to get it." plus a Download button, for images, HTML, PDF and text; cut
  text: "Showing the first 1 MB of 1.5 MB. Text files over 1 MB open cut and read-only. Use
  Download to get all of it." with a Download button. Unknown/binary files also get the button.
- **Column position:** the grid is rail | artifact column | conversation
  (`components/shell/shell.module.css`, `@media (width >= 820px)`). Fixed in `glossary.md`,
  `for-agents/concepts.md` and `getting-started/layout.md` (which also had the conversation "in the
  middle"); layout.md now also says how to resize it and that it is a sheet under 820 px. The UI
  label "Opened in the side column" (connectors page) is a quoted label and stays.

## Docs

`files/file-editor.md` (The image viewer, Files over the preview limits), keyboard shortcuts
(image viewer keys), glossary, layout, for-agents concepts.

## Open questions (for Chris or the coordinator)

- None. No browser spec for the image viewer (component tests cover it); the KOBE-801 spec covers
  the shared surround and keys.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/files/image-viewer.test.tsx` (dimensions and size, checkerboard, fit/actual,
  zoom by mouse and keys, drag to pan, SVG as `<img>`); `file-viewer.test.tsx` renderers test.
- ac-2: `lib/files/preview.test.ts` "large-file messages"; `file-viewer.test.tsx` caps test (text,
  image, HTML, PDF notes with Download).
- ac-3: guide pages above; `pnpm --filter @kobe/server exec vitest run src/kobe-mcp/docs`.
- ac-4: tests above.
