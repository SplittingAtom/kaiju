# KOBE-808: Code editor: code completion (built-in plus the running Python kernel)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the PRs)
- **Branch / worktree:** `group-93-centre-completion` in `../Kobe-g93`, stacked on
  `group-88-combined-80-79-84` (KOBE-803's wire).
- **Migration:** none (an `op` on the existing `notebook.inspect` command kind, like
  `notebook.restart`'s `op: "start"`; the kind's CHECK constraint is unchanged).

## Decisions

- **Path end to end.** Editor (`components/files/editor-completion.ts`, `lib/notebooks/kernel-completer.ts`)
  → `POST /v1/threads/{id}/notebook/complete` `{op: "complete", code, cursor}` | `{op: "doc", name}`
  (`services/server/src/notebooks/completion.ts`) → router `notebookComplete` (a `notebook.inspect`
  row with `op`, `wake: false`) → delivery preflight (needs `notebooks` + new capability
  `notebook_complete`, never an eval sandbox) → agent `KernelManager.complete`
  (`services/sandbox-agent/src/notebook/completion.ts`) → bridge ops `complete` / `doc`
  (`images/sandbox/kernel/kobe-kernel-bridge.py`). Contract: `packages/protocol/src/notebook-completion.ts`.
- **Evaluation safety (the choice).** `complete` is Jupyter `complete_request` with the kernel
  started as `--IPCompleter.use_jedi=False --IPCompleter.evaluation=limited` (`KERNEL_ARGS`).
  Checked against ipykernel 7.4.0 / IPython 9.17.1 / jedi 0.20.1 (the image's pins): with jedi on
  (IPython's default) completing `c.p.` ran a property getter twice; with these flags it ran
  none, and live variables, attributes, `df['` column keys and module members still complete.
  `limited` evaluates no calls, property getters or imports (auto-import stays off). Remaining
  risk: `dir()` on an object can call a custom `__dir__`. **`doc` sends no code at all**: the editor
  sends a dotted name (`^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,15}$`, checked by the server and the
  bridge); a silent user expression (`DOC_SOURCE`, like 803's snapshot: no execution count, no
  `Out`) resolves it with `inspect.getattr_static` (no descriptors, no `__getattr__`) and reads
  signatures (functions and classes only) and docstrings (an instance's type's), never a repr,
  under a 300 ms SIGALRM. IPython's own `inspect_request` was not used: it calls `str()` on
  non-callables. Verified by `completion-source.test.ts` (hostile object: nothing ran) and the new
  `test-image.sh` check against the real kernel (run by hand with the pinned versions in a venv).
- **Never wakes, never starts, never waits.** Server: no live connection → `asleep` (and the
  router sends with `wake: false`). Agent: no kernel → `no_kernel`; a run executing or queued, a
  snapshot in progress or another completion in the kernel → `busy`; past `timeout_ms` (1 s) →
  `unavailable` (the bridge gives up on its own deadline and skips the late reply by message id; an
  execution sent meanwhile simply waits behind it in the bridge). A request keeps an idle kernel
  from idling out (it is use). The editor gives up after 2 s and cancels on every keystroke.
- **States are 200 answers** (`busy`, `no_kernel`, `asleep`, `unsupported`, `unavailable`) so the
  editor falls back quietly; errors stay errors (404/403 `read_only`/409 `skill_eval_thread`/429
  `rate_limited`/503). An older agent, an agent without kernels, or an older replica in a rolling
  deploy (`invalid_command`) → `unsupported`; the editor stops asking for that tab.
- **Scoping.** Owner only via `findThread` without the thread lock (completion changes nothing and
  must not queue behind runs; trash refused), `assertMayRun`, isolation present, eval threads
  refused by the route guard, the member's own sandbox only (preflight). Shared readers get no
  kernel completion in the UI either.
- **Rate limit: 600 per minute per member** (`notebook-complete:<user>`, durable `hitRateLimit`) —
  the coordinator's number. The editor debounces (150 ms), reuses a result while typing more of a
  name (`validFor`), backs off after `no_kernel` (5 s), `asleep` (10 s), `busy` (1.5 s),
  `unavailable` (3 s) and 429 (20 s). Row in `docs/rate-limits.md`.
- **Nothing stored or logged with code.** No run, event or audit row (`notebook-completion.db.test.ts`
  checks). The code sits in the `sandbox_commands` row only while the command is in flight: the
  route's read deletes it (`takeResult`, also on timeout via `expireCommand`); unread ones are swept
  within a minute (803's rule for `notebook.inspect`). Logs carry the op and failure code only.
- **Caps.** Code ≤ 32 KiB (the editor sends whole lines up to 6 000 characters before the cursor
  and its line to the end, ≤ 1 000 after); ≤ 100 matches of ≤ 200 characters; signature ≤ 1 000,
  docstring ≤ 8 000 characters; ANSI stripped; rendered with `textContent` only.
- **Editor.** `@codemirror/autocomplete` added to `apps/web` (MIT, already in the lockfile
  through the language packages; `pnpm licenses:update` run). Built-in sources: `python()` and
  `javascript({typescript})`'s support data (JSX/TSX without tag auto-closing). Completion only in
  editable views (a compartment with read-only). Keys: typing, Ctrl+Space (Mac also Alt+I), Tab or
  Enter accepts, Escape closes; Ctrl+Shift+Space shows signature and docs; hover shows docs;
  typing `(` or `,` in a call shows the signature. Kernel matches carry detail "kernel", boost 50,
  and drop names the built-in sources already offer. The status bar shows why kernel completion
  is off (`KERNEL_STATE_TEXT`).
- **Not done (scope):** kernel completion in `.ipynb` cells (built-in completion works there);
  completions while code runs (falls back, as the ticket says).
- **Docs:** `docs/guide/files/file-editor.md` ("Code completion"), `files/notebooks.md` ("Code
  completion from the kernel"), `reference/keyboard-shortcuts.md` and the `?` sheet
  (`EDITOR_KEYS`). No "For agents" change: agents' `run_python` and tools are unchanged.

## Open questions

- Should the agent-side 1 s kernel timeout be configurable per site? Fixed for now.

## Evidence

- ac-1: `apps/web/components/files/code-editor.test.tsx` (Python and TypeScript built-in, Tab
  accepts, read-only never completes).
- ac-2: bridge on the real kernel (`images/sandbox/test-image.sh` "kernel completion and docs ...",
  run locally against the pinned packages: `ok my_value|alpha,beta|alpha|| m(x, y=2) Doc of m. 1 (0,0)`);
  `services/sandbox-agent/src/notebook/completion-source.test.ts`; editor merge/ranking in
  `editor-completion.test.ts` and `code-editor.test.tsx`; signature/hover names in `editor-completion.test.ts`.
- ac-3: `lib/notebooks/kernel-completer.test.ts` (states, backoff, cancellation, 429),
  `editor-completion.test.ts` (debounce, abort), `python-run.test.tsx` (indicator, reader, no thread).
- ac-4: protocol `notebook-completion.test.ts`; `agent.notebooks.test.ts` (capability, no kernel
  started); `manager.completion.test.ts`; `sandbox-wire/delivery/notebook-complete.test.ts`;
  `services/server/src/notebook-completion.db.test.ts` (scoping, asleep without a wake, timeout,
  older agent, rate limit, nothing stored).
- ac-5: OpenAPI catalog entry + `openapi.json`, `route-inventory.app.txt` (one line), browser spec
  `e2e/browser/tests/code-completion.spec.ts` (UNRUN here: needs the gate install).
