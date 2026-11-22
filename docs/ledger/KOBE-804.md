# KOBE-804: Python editor: the bottom pane becomes tabs (Run Output, Log, Variables)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed on `group-92-centre-run-pane` (not pushed)
- **Branch / worktree:** `group-92-centre-run-pane` in `../Kobe-g92`, stacked on
  `group-88-combined-80-79-84` (PR #685, holds KOBE-803's wire)
- **Depends on:** KOBE-803 (timing, error and the variables route)

## Decisions

- **Where the data comes from.** Run Output and Log read the page's execution store
  (`lib/notebooks/executions.ts`), fed by the run streams as before; the store now also keeps
  `startedAt` (the event time), `seenAt` (this browser's clock, for the live clock) and KOBE-803's
  `timing` and `error` from `notebook.finished`. Variables call `POST /v1/threads/{id}/notebook/variables`
  (new `NotebookApi.variables`), no wire change. Followed 803's ledger; the brief agrees with it.
- **Variable values are never stored** (coordinator's decision, 803): kept only in the open
  editor's React state (`use-variables.ts`), never in the store, storage or the URL. Asked when the
  Variables tab is shown and the thread's newest finished run (any file or agent code) differs
  from the one the last answer followed, so the 60/min route limit is spent only while looking.
  Never asked while code runs (the old values stay with a stale note) nor by a shared reader (the
  route is owner-only; the tab says so). Refresh sends `{refresh: true}`.
- **States.** No runs: each tab explains itself. `no_kernel`: "not running, Run or Start".
  `variables_unsupported` / `notebooks_unsupported`: "not available yet: older Kobe agent".
  `unavailable`, `busy`, `stale`, `auto_paused`, `truncated` each have a plain line. Loading:
  "Reading the variables…". Other errors: `ErrorNotice`.
- **Safe values.** Reprs are rendered as React text only (a test checks `<b>`/`<img>` in a repr
  stay text); C0/C1 controls and bidi overrides show as `\uXXXX`; the row cuts at 80 characters,
  the expanded row at 400 (the wire caps at 200). Names that look like credentials (`token`,
  `secret`, `password`, `api_key`, `auth`, `cookie`, ...) and `os.environ` (`_Environ`) show
  "Hidden" with a Show button. 803 already leaves out `_` names, IPython's own names, modules,
  functions and classes (listed by name only) and never reads DataFrame data.
- **Tabs.** Same pattern as `shell/rail-tabs.tsx` (automatic activation, Left/Right wrap,
  Home/End, roving tabindex, panels stay mounted with `hidden`). The tablist sits in the split's
  header row (new `SplitPane` `header`), so the pane keeps its height and collapse/close buttons:
  no layout shift. Tokens only (`--primary` underline and badge dot, `--muted`, `--border`), so
  every preset follows. Badge = dot plus sr-only ", new output" / ", a run failed".
- **Remembered.** The chosen tab per member in this browser (`kobe.pythonRun.tab`, like the
  split's `kobe.fileEditor.split`); the shown run, Clear, the Variables filter/sort/open rows and
  shown secrets per file (state keyed by path) while the editor is open.
- **Log.** This file's runs in this conversation, newest first (`fileRuns`), from what this page
  has seen (run events are replayed on load as before); choosing one shows it in Run Output until a
  newer run comes. Error name and line from 803; a Run selection's line is mapped back to the file
  (KOBE-805). "Go to line" moves the cursor (new `CodeEditor` `reveal`, focus after a frame).
- **The split always renders for a `.py` file** (bottom null = code alone), so opening the output
  no longer remounts the editor: the cursor and undo history survive a run (was a KOBE-615 side
  effect; needed for Shift+Enter and Go to line).
- **Show run pane** (toolbar, folds into More) opens the pane without a run.

## Docs

- `docs/guide/files/notebooks.md`: Python files section and a new "The run pane" section;
  troubleshooting. `file-editor.md`: toolbar list. `reference/keyboard-shortcuts.md`: tabs line.
  "For agents" unchanged: `run_python` results are the same and the agent never sees variables.
- Guide tests (`@kobe/guide`, server `kobe-mcp/docs` docs_full cap) pass.

## Open questions

- The Log shows what this page has seen of the thread's runs (the store keeps the last 200
  executions per session); an older run, or one from another tab before load, appears only if its
  events are replayed. Enough for v1?

## Evidence

- ac-1: `components/notebooks/run-pane.test.tsx` "three tabs with roving focus...", "remembers
  the chosen tab".
- ac-2: `run-pane.test.tsx` "lists runs newest first...", "Clear...", "marks a tab..." ;
  `lib/notebooks/executions.test.ts`, `lib/notebooks/run-log.test.ts`.
- ac-3: `run-pane.test.tsx` "shows name, type and value...", "is stale while code runs...";
  `lib/notebooks/variables.test.ts`, `lib/notebooks/api.test.ts`.
- ac-4: `run-pane.test.tsx` "explains each tab before any run", "says when the kernel is not
  running, the agent is too old...", "explains itself before the first answer, and a shared reader
  never asks".
- ac-5: browser spec `e2e/browser/tests/notebook.spec.ts` "python file: run pane tabs, log,
  variables, save-and-run, run selection, stop" is UNRUN (needs the test install with a KOBE-803
  sandbox agent); guide updated.
- Suites: web `components/files components/notebooks components/shell lib/notebooks lib/shell
lib/files` 94 files / 979 tests green; web typecheck, eslint, prettier clean.
