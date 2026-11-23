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
- **Evaluation safety (the choice; security review rounds 1-4).** IPython's completer is not
  used at all (round 3: after patching its evaluator, dir, key lister and generics, its
  keyword-argument matcher still `eval`ed the callee; a 10 M-entry dict blocked the kernel). The
  launcher replaces `IPythonKernel.do_complete`/`do_inspect` (async, so ipykernel warns about
  nothing) with calls into `STATIC_SOURCE` on `shell.user_ns`, and the bridge sends
  `complete_request` / `inspect_request` (round 4: the earlier silent `execute_request` with a user
  expression fired `post_execute`, input transformers and any `str` formatter on every keystroke).
  ipykernel 7.4's `complete_request`/`inspect_request` handlers call only `do_complete`/
  `do_inspect`, `json_clean` and `send`: no transformers, events, formatters, history, `_` or
  execution count. `transport.e2e.test.ts` (with `KOBE_TEST_KERNEL_PYTHON`) and `test-image.sh` run
  `images/sandbox/kernel-transport-probe.py` through the real bridge with `pre/post_execute`,
  `pre/post_run_cell`, an input transformer, a `str` formatter, a warnings hook and autoreload
  (its callbacks wrapped): zero calls, count/history/Out unmoved; the round-3 bridge records 36. The resolver tokenises the text
  before the cursor itself (last 300 characters; open-call scan ≤ 2 000): a chain of names,
  `.attr`, `['str']`/`[int]` (≤ 10 steps) resolved through namespace dicts, module dicts, class
  dicts along `type.__mro__` and the instance dict via the C-level `__dict__` descriptor; it
  stops at properties, `cached_property` (unless already cached in the instance dict), any other
  descriptor, data descriptors, classes whose metaclass is not exactly `type`, types defining
  `__getattribute__`, names only a module `__getattr__` would give, tuple keys, and dict keys of
  another exact type (keys are compared only with keys of the same exact plain type). It offers
  names from the user namespace (not `_`-prefixed or IPython's), attribute names from those
  dicts, keys of exact `dict` (str/int/float/bool), DataFrame column labels only through a
  non-executing path (`_mgr` → C getset `axes` → the Index's numpy object array, or a Python-backed
  `StringArray`'s `_ndarray` C getset; PyArrow-backed labels, pandas 3's default when PyArrow is
  installed as in the image, are not offered), and `name=` keyword arguments from plain functions' code objects, a
  plain class's `__init__`/`__new__` and built-ins' `__text_signature__`. Caps: 10 000 entries
  examined (`itertools.islice`), 200 returned (the bridge then keeps 100), 200 ms budget checked
  between steps. Not while a member `ITIMER_REAL` is pending (`error: "timer"`); nothing is
  interrupted. **Tested:** `completion-source.test.ts` runs every probe of rounds 1-3 (hooks,
  `__class__` property, `__getattribute__`, metaclass `__getattr__`/`__getattribute__`, lazy
  proxy, lock-holding `cached_property`, property, descriptors, hashing keys, tuple keys with a
  member element, module `__getattr__`, `__signature__` property, the keyword path on all of
  them): zero calls, lock never taken, nothing cached; a 10 M-entry dict answers in ~15 ms and the
  next request is immediate; usefulness (namespace names, module members, instance attributes,
  dict keys, kwargs from functions/classes/built-ins). The `test-image.sh` real-kernel check
  covers the same plus DataFrame columns, the pending timer and a run right after the big dict;
  the round-1 and round-2 bridges fail it. The reviewer's seven probe scripts give zero calls.
  Dict lookups iterate and compare only exact `str` keys (`_find`), so a non-str or `str`-subclass
  key in a namespace, module, class or instance dict is never hashed or compared (round 4 L1;
  tested). `doc` uses the same dict-only reads,
  classifies by `type(obj)`, builds signatures from `__code__`/`__defaults__` (defaults other than
  plain numbers/strings shown `…`, no annotations).
- **Follow-up (KOBE-803, not changed here):** the variables snapshot still travels as a silent
  `execute_request` with a user expression, so it fires `post_execute`, input transformers and a
  `str` formatter once per snapshot (after a member's run and on Refresh). Same remedy available
  (a custom message or `inspect_request`-style handler); for the coordinator to ticket.
- **Review L7 (gone):** completion and docs no longer use user expressions, so a rebound `exec`
  no longer matters for them; 803's snapshot still has that pattern (part of the follow-up).
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
