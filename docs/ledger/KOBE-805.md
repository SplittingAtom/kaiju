# KOBE-805: Python editor: run what you see (save-and-run, shortcuts, stop, clock, selection, restart)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed on `group-92-centre-run-pane` (not pushed)
- **Branch / worktree:** `group-92-centre-run-pane` in `../Kobe-g92`
- **Depends on:** KOBE-804 (run pane), KOBE-803 (timing)

## Decisions

- **ac-1: Run saves, then runs the saved file** (not the buffer): the server keeps reading the
  saved synced file, so what runs is always what is saved. A note above the editor says "Run saves
  your changes first, then runs the saved file."; a failed save (conflict, read-only) runs nothing
  and says so. `FileEditor` gives runnable files an `EditorRunContext` (`saveFirst`, `selection`,
  `dirty`).
- **ac-2 keys:** in the code editor Shift+Enter runs the selection, or the whole file without one;
  Mod+Enter runs the whole file (also runs a notebook cell now, which used to insert a blank line);
  Mod+S saves any editable file (never the browser's Save page). In the `?` sheet
  (`EDITOR_KEYS`) and the keyboard-shortcuts guide.
- **ac-3:** Stop (interrupt) replaces Interrupt in the `.py` toolbar and shows only while code
  runs; Run is disabled then. A clock beside the kernel state: "Running 0:07" (this browser's
  clock from when the run appeared), then "Done in 1.2 s" / "Error after 0.3 s" from 803's
  `timing` (just the status word without timing). Notebooks keep Interrupt.
- **ac-4 Run selection needed a wire change (smallest possible):** `NotebookRunBody` gains
  optional `lines: {start, end}` (1-based, inclusive, `.py` only). The server still reads the
  saved file and slices it (`services/server/src/notebooks/lines.ts`: stops at the file's end,
  removes common indentation, a range with no code is `invalid_request` 400). The body never
  carries code. `openapi.json` regenerated with `UPDATE_OPENAPI=1` (the document test), not by
  hand; no new route or audit event. The web notes the range on the execution
  (`NotebookExecStore.noteLines`) to show "lines 2–3" in the Log and map an error line back.
  Note: this is a protocol contract change inside a feature branch (parallel-work.md prefers its
  own PR); it is additive and optional, in its own files plus one schema field.
- **ac-4 kernel:** Restart still confirms; the prompt now says "Its variables are cleared and its
  imports are lost." New phase `restarting` ("Restarting kernel…", Restart busy); "No kernel"
  became "Kernel not started" (states: not started, waking, starting, idle, busy, restarting).
- **(6) caps and timeouts:** `TRUNCATED_NOTE` names the caps from the protocol constants (200
  outputs, 2 MB) and what to do; `TIMEOUT_NOTE` suggests making it faster or Run selection.

## Review fixes (2026-11-22)

- **M1 one trigger, one run:** `PythonFile` holds an in-flight ref from the click or key until
  the run request settles, and checks the store's busy state directly (not the last render);
  `saveFirst` refuses while a save is in flight; the editor swallows repeated Shift/Mod+Enter
  (a keymap `any` binding on `event.repeat`).
- **L1** `lines` recorded on `notebook.started` (protocol, server), used by the web store instead
  of the tab-local note. **L4** `lines` capped at 1,000,000 (`NOTEBOOK_LINE_MAX`). **L9** Stop is
  disabled (busy) while its interrupt is on the way.
- Skipped: **L3** (tie the save to the run with a `sha256`/409): rare window, needs a new error
  code and the saved version plumbed from the editor; **L5** (dedent touches multi-line strings):
  expected Run-selection behaviour, as in most IDEs.

## Docs

- `docs/guide/files/notebooks.md` (Run, Run selection, keys, Stop and clock, kernel states,
  troubleshooting), `files/file-editor.md` (toolbar, Mod+S), `reference/keyboard-shortcuts.md`
  (three new editor keys). No "For agents" change: `run_python` is unchanged.

## Evidence

- ac-1: `python-run.test.tsx` "Run saves unsaved changes first...", "a save that fails runs nothing".
- M1: `python-run.test.tsx` "one trigger, one run": double click (and a script that ends at once),
  held Shift+Enter, unsaved edits double trigger.
- ac-2: `python-run.test.tsx` "Shift+Enter and Mod+Enter run from the editor; Mod+S saves";
  `code-editor.test.tsx` "run and save keys"; `shortcut-keys.test.tsx`.
- ac-3: `python-run.test.tsx` "Stop and a live clock...".
- ac-4: `python-run.test.tsx` "Run selection runs the selected lines...", "Restart asks first...";
  protocol `notebooks.test.ts` (lines); server `notebooks/lines.test.ts` and
  `notebooks.db.test.ts` "runs only the named lines of a .py file" (17/17 against the dev
  Postgres); `src/openapi` tests green.
- ac-5 / (6): `python-run.test.tsx` "a run cut at the output cap..."; browser spec in
  `notebook.spec.ts` (UNRUN, see KOBE-804); guide updated.
