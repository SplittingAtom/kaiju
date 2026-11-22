# KOBE-806: Code editor: find and replace, go to line, line-wrap toggle, copy path

- **Status:** committed on `group-82-editor-raw-find` (not pushed)
- **Branch / worktree:** `group-82-editor-raw-find` in `../Kobe-g82`

## Decisions

- `@codemirror/search` was not installed (not even transitively): added to `apps/web` (MIT, 6.7.2);
  `pnpm licenses:update` regenerated `THIRD_PARTY_LICENSES.md`.
- Keys: Mod+F find, Mod+G / Shift+Mod+G next/previous, Mod+Alt+F opens the panel in the Replace
  field, Mod+Alt+G go to line (CodeMirror's own binding), Escape closes. Listed in the `?` sheet
  (new "In the code editor" list) and the keyboard-shortcuts guide.
- Panel, fields, buttons and match highlights use the theme tokens (`--muted`, `--border`, `--ring`),
  so dark and the Catalyst preset follow; the panel's labels are CodeMirror's own (Find, Replace, next,
  previous, all, replace, replace all, close).
- Line wrap: new wire key `editor_line_wrap` (protocol schema + web `editorLineWrap`), default on,
  saved through the shell preferences; a Wrap button in a status bar under the editor (not in notebook
  cells). Line and column sit in the same bar.
- Copy path in the file tab header copies `sandboxPathOf(path)` (`/workspace/<path>`, as @file does),
  with a "Path copied" status; it reuses the `copy-file-path` command entry.

## Evidence

- `code-editor.test.tsx`, `file-editor.test.tsx`, `preferences.test.ts`, `ui-preferences.test.ts`,
  `shortcut-keys.test.tsx`.
- Not covered by a test: submitting Go to line moves the selection (happy-dom's selectionchange makes
  CodeMirror throw there); only the keyboard route to the dialog is tested.
- Browser specs: unchanged expectations in file-editor/open-file/notebook; no new browser spec
  for 806 (unrun here in any case).
