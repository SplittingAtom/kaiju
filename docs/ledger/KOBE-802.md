# KOBE-802: Python files open in the code editor in Raw mode

- **Status:** committed on `group-82-editor-raw-find` (not pushed)
- **Branch / worktree:** `group-82-editor-raw-find` in `../Kobe-g82`

## Decisions

- The default mode per kind is `defaultModeOf()` in `apps/web/lib/files/preview.ts` (Python Raw,
  all else Rendered); `FileEditor` is the one place that uses it, so plain and python-run agree.
- The member's explicit switch is kept in `EditDraftStore.chosenModes` (page session, per path).
- The editor takes the cursor only when the file opened in Raw by itself (not on a click of Raw).
- Read-only Python (project reader, over 1 MB) opens Raw, read-only, with the existing reason note.
- Other tests that assumed `.py` opens Rendered (file-viewer.test) now use `.sh`.

## Evidence

- ac-1..3: `file-editor.test.tsx`, `python-run.test.tsx`, `lib/files/preview.test.ts`.
- ac-4: guide `files/file-editor.md` and `files/notebooks.md` updated; browser spec
  `e2e/browser/tests/file-editor.spec.ts` (new Python test) is UNRUN (no gate install here).
