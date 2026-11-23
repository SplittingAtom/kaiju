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
- **Log.** This file's runs in this conversation, newest first (`fileRuns`). Review M2
  (coordinator: durable if already recorded): the runs are already in `run_events`
  (`notebook.started`/`notebook.finished`, member and agent runs, kept until D18 compacts a run 7
  days after it ended), so no new storage: new owner-only read routes
  `GET /v1/threads/{id}/notebook/executions?path=` (last 50, newest first, without outputs, with
  `run_ended`) and `GET .../executions/{exec_id}/outputs` (`services/server/src/notebooks/history.ts`,
  inside `withTeam()`, `team_id` stated, owner check via `findThread`; readers 404 like the other
  notebook routes for non-shared threads, 403 `read_only` for shared readers). OpenAPI catalog
  entries (generated `openapi.json`, not committed since KOBE-815), route-inventory snapshot updated. The pane loads it once per
  file and thread when it opens (`NotebookExecStore.seed`), outputs of a shown older run on demand
  (`fillOutputs`); responses keep wire casing (read as text, checked with the protocol schemas). An
  unfinished entry whose run is still active is left to its live stream; one whose run ended shows
  `failed`. Seeded runs raise no tab dot. Choosing a run moves focus to the Run Output panel (M3).
  Error name and line from 803; a Run selection's `lines` are now on `notebook.started`, so the
  line maps back after a reload too (L1). "Go to line" moves the cursor (`CodeEditor` `reveal`).
- **The split always renders for a `.py` file** (bottom null = code alone), so opening the output
  no longer remounts the editor: the cursor and undo history survive a run (was a KOBE-615 side
  effect; needed for Shift+Enter and Go to line).
- **Show run pane** (toolbar, folds into More) opens the pane without a run.

## Docs

- `docs/guide/files/notebooks.md`: Python files section and a new "The run pane" section;
  troubleshooting. `file-editor.md`: toolbar list. `reference/keyboard-shortcuts.md`: tabs line.
  "For agents" unchanged: `run_python` results are the same and the agent never sees variables.
- Guide tests (`@kobe/guide`, server `kobe-mcp/docs` docs_full cap) pass.

## Review fixes (2026-11-22)

- M2, M3 as above; L2 the live clock counts from the server's start time (never in this
  browser's future) so a reload keeps counting; L6 wider credential-name guard (`access_key`,
  `key`, `pwd`, `dsn`, `conn_str`; no longer `author`); L7 an ask after a run waits 1 s (bursts
  cost one ask) and a 429 is a quiet line.
- Round 2 lows: R2-L1 a failed outputs read says so and is retried when Run Output shows the run
  again; R2-L2 a run that ended before its execution still has its stored outputs read; R2-L3 DB
  test pins 403 `read_only` for a shared reader; R2-L4 guide wording ("7 days after the run they
  were part of ended").
- Skipped: L8 (tab remembered per browser, not per user id: same as the split's existing key;
  keying it needs the user id plumbed into the editor; only matters on a shared browser).

## Evidence

- ac-1: `components/notebooks/run-pane.test.tsx` "three tabs with roving focus...", "remembers
  the chosen tab".
- ac-2: `run-pane.test.tsx` "lists runs newest first..." (focus, M3), "Clear...", "marks a tab...",
  "loads the file's stored runs when the pane opens..." (M2, L1); server `notebooks.db.test.ts`
  "lists a .py file's past runs from stored events..."; `api.test.ts`, `executions.test.ts` (seed);
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
