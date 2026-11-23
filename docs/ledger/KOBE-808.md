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
- **Evaluation safety (the choice; security review rounds 1 and 2).** `complete` is Jupyter
  `complete_request` with jedi off (`KERNEL_ARGS`; jedi's interpreter mode ran a property getter).
  IPython's `limited` policy still ran member code (round 2: `cached_property` computed and
  stored, custom descriptors, metaclass `__getattribute__`, key `__hash__`/`__eq__`), and round 1's
  0.5 s SIGALRM then cut a member getter mid-way (a lock stayed held; with a member timer pending
  the kernel hung). Now the launcher's `COMPLETER_GUARD` replaces every completer part that
  touches member objects, so nothing of the member's runs and nothing is ever interrupted:
  `guarded_eval` (used only by the completer) → a static evaluator: names (namespace dicts, then
  builtins), plain constants, attributes from type/instance dicts (plain values, functions,
  static/class methods, C-level getset/member descriptors; refused: properties, `cached_property`
  unless already cached in the instance dict, any other descriptor, data descriptors before the
  instance dict, classes whose metaclass is not exactly `type`, types defining
  `__getattribute__`, missing names), items of exact dict (keys compared only with keys of the
  same exact plain type; ≤100 000 entries), list/tuple (int) and DataFrame (str column found by
  scanning `columns`) by plain immutable keys; calls and operators refused. `dir2` → static dir
  (exact pandas DataFrame/Series keep `dir()`); keys only from exact dict (str/bytes), DataFrame,
  ndarray; `complete_object` never consulted (registered completers don't run; `register` still
  works). No in-kernel alarm: the bridge's deadline discards a late answer; `do_complete` and
  `doc` refuse while a member `ITIMER_REAL` is pending. Guard failure → the kernel completes
  nothing. **What still runs in `complete`:** IPython's own completer code, and pandas'
  `dir()`/`columns`/`__getitem__` and numpy `dtype.names` for exact library types. Tested:
  `guard-harness.py` (lock-holding `cached_property`: lock never taken, nothing cached;
  descriptors; metaclass `__getattribute__`; `__getattribute__`; hashing keys; object hooks;
  registered completer; pending timer) and the `test-image.sh` real-kernel check (zero hits; the
  round-1 bridge fails it). The reviewer's five probe scripts also give zero hits. **`doc`:** the
  editor sends a checked dotted name only; `DOC_SOURCE` resolves it from dicts only (no
  `inspect.getattr_static`, whose `entry.__dict__` ran a metaclass `__getattribute__`; classes
  whose metaclass is not `type` are not looked into; descriptors returned raw), classifies by
  `type(obj)`, builds signatures from `__code__`/`__defaults__` (defaults other than plain
  numbers/strings shown `…`, no annotations), reads docstrings through built-in types'
  descriptors. Hostile objects record zero calls (`completion-source.test.ts`).
- **Accepted (review L7):** the user expressions (`DOC_EXPRESSION`, like 803's snapshot) call
  `exec` resolved in the member's namespace; a member who rebinds `exec` runs their own code on
  hover. Self-inflicted in their own kernel; shared with KOBE-803.
- **Not activity (review L2).** Completion commands are routed with `activity: false`: they do
  not touch `sandboxes.last_active_at`, and the agent does not reset the kernel's idle timer, so
  typing never keeps a sandbox or kernel awake.
- **Never wakes, never starts, never waits.** Server: no live connection → `asleep` (and the
  router sends with `wake: false`). Agent: no kernel → `no_kernel`; a run executing or queued, a
  snapshot in progress or another completion in the kernel → `busy`; past `timeout_ms` (1 s) →
  `unavailable` (the bridge gives up on its own deadline and skips the late reply by message id; an
  execution sent meanwhile simply waits behind it in the bridge). A second request while one is in
  the kernel waits for it instead of answering `busy` (review L4); the editor keeps one request in
  flight (newest wins), cancels on every keystroke, cancels a hover lookup when the pointer moves
  on (L5), and gives up after 2 s.
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
- **Caps.** Code ≤ 32 KiB, no U+0000 and no lone surrogate (jsonb refuses both; 400, review L3) (the editor sends whole lines up to 6 000 characters before the cursor
  and its line to the end, ≤ 1 000 after); ≤ 100 matches of ≤ 200 characters; signature ≤ 1 000,
  docstring ≤ 8 000 characters; ANSI stripped; rendered with `textContent` only.
- **Editor.** `@codemirror/autocomplete` added to `apps/web` (MIT, already in the lockfile
  through the language packages; `pnpm licenses:update` run). Built-in sources: `python()` and
  `javascript({typescript})`'s support data (JSX/TSX without tag auto-closing). Completion only in
  editable views (a compartment with read-only). Keys: typing, Ctrl+Space (Mac also Alt+I), Tab or
  Enter accepts, Escape closes; Ctrl+Shift+Space shows signature and docs; hover shows docs;
  typing `(` or `,` in a call shows the signature. Kernel matches carry detail "kernel", boost 50,
  and drop names the built-in sources already offer. The status bar shows why kernel completion
  is off (`KERNEL_STATE_TEXT`, `aria-live="off"`); a separate polite live region announces only
  the off reasons, each once (review L6).
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
