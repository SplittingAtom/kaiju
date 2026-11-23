# KOBE-816: Variables snapshot off silent execute; no member code to show values

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the PR)
- **Branch / worktree:** `group-100-vars-transport` in `../Kobe-g100`, stacked on
  `group-93-centre-completion` (KOBE-808, whose transport and static source this reuses).
- **Depends on:** KOBE-803 (snapshot), KOBE-804 (Variables tab), KOBE-808 (inspect handler).

## Decisions

- **Transport.** The bridge's `inspect` op now sends an `inspect_request` whose code is
  `VARIABLES_MARKER` (`"\x01kobe-variables "`, never a dotted name the server accepts) plus the
  caps as JSON. The launcher's replaced `do_inspect` answers it from `STATIC_SOURCE.variables` on
  `shell.user_ns` (execution count `shell.execution_count - 1`, as the old silent execute's
  reply). ipykernel 7.4's inspect handler calls only `do_inspect`, `json_clean` and `send`: no
  input transformers, no `pre/post_execute` or `run_cell` events, no display formatters, no
  history, no `_`, no execution count. `INSPECT_SOURCE`/`INSPECT_EXPRESSION` are gone (the
  silent execute with a user expression, and the per-variable SIGALRM that could cut a member's
  `__repr__` mid-way, holding its locks). The agent, wire and route are unchanged.
- **What runs to show values (the choice).** No member code. The 803/804 guide promised "a short
  value" with summaries as examples, not `repr`, so there is no opt-in "Show value" running
  `repr`: values are read only for
  - exact `int`/`float`/`complex`/`bool`/`None` (their C reprs; an int over ~200 digits is
    "<int of about N digits>"), exact `str`/`bytes`/`bytearray` (a slice's repr), `range`;
  - exact `list`/`tuple`/`dict`/`set`/`frozenset`: up to 8 items, 2 levels, 200 characters,
    elements by the same rule, anything else inside as `<TypeName>`; iteration through the
    built-in's own C methods (`dict.items`, `list.__iter__`), keys never hashed or compared;
  - subclasses of those: the built-in's `__len__` and items (never the subclass's `__repr__`,
    `__len__`, `__iter__`, `items`);
  - exact numpy `ndarray` (shape, dtype; `array2string` only for numeric kinds `biufc`), exact
    pandas `DataFrame` (rows, columns, the first 50 column labels and dtypes; labels that are not
    plain values show as `<TypeName>` and then no dtypes are asked) and `Series` (length, dtype):
    library code on library objects.
  - Anything else (a member's class, another library's object, an object-dtype array): type only,
    `repr: ""`, `repr_error: "not_read"` (protocol enum extended; web shows "(value not shown for
    this type)"). Type names come from `type()` and C slots, never `__class__`.
- **Bounds.** 200 variables (and 200 other names), 64 KiB payload, 200-character values, 50
  columns, a 2 s budget checked between variables (`truncated`), at most 50 000 namespace
  entries examined. Never during a run (the agent answers from the kept snapshot or `busy`, as
  before); never wakes a sandbox or starts a kernel (route and agent unchanged). An agent-side
  timeout still interrupts the kernel; the handler catches `KeyboardInterrupt` and answers an
  error (no member frame is ever interrupted: none runs).
- **Variables tab contract.** Unchanged except the new `repr_error: "not_read"`; the
  hidden-until-Show rule for credential-like names and `os.environ` stays a web rule on the name
  and type, which the snapshot still sends. An older server rejects `not_read` from a newer agent
  (`unavailable`) during a rolling deploy until the server is updated: servers deploy first.
- **A member's timer:** unlike completion (which refuses while one is pending), the snapshot
  does not refuse: it runs nothing of the member's and no signal of its own; a member's signal
  handler can run whenever the kernel handles any message, this one included.
- **Docs:** `docs/guide/files/notebooks.md` (Variables: what is shown, what never runs, bounds);
  OpenAPI description (`openapi/notebook-variables.ts`). No "For agents" change (agents never see
  snapshots).

## Open questions (for Chris or the coordinator)

- Values of other libraries' objects (polars frames, datetime, Decimal) now show the type only.
  A follow-up could add more exact library types read through their own C attributes.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `images/sandbox/kernel-transport-probe.py` (run by `test-image.sh` and by
  `services/sandbox-agent/src/notebook/transport.e2e.test.ts` with `KOBE_TEST_KERNEL_PYTHON`):
  with `pre/post_execute`, `pre/post_run_cell`, an input transformer, a `str` formatter, a warnings
  hook, autoreload and a recording `__repr__`, a snapshot adds zero calls and leaves the execution
  count, history and `Out` unmoved: `... vars=3,not_read`; the group-93 bridge gives 7 hook calls
  and `Thing()` (its repr ran). The test-image KOBE-803 check now expects `not_read` for the
  raising and looping reprs (run locally against the pinned ipykernel/IPython with real
  numpy/pandas).
- ac-3: `services/sandbox-agent/src/notebook/inspect-source.test.ts` (recording `__repr__`,
  `__str__`, `__len__`, `__iter__`, `__format__`, `__class__` property, `__getattribute__`,
  metaclass hooks, a lock-holding repr, hooked list/dict subclasses, hashing keys: zero calls, lock
  never taken; 5 M-item list, 2 M-entry dict, 10 M-char str, 100 000-digit int bounded in
  milliseconds; caps and budget); protocol `notebook-variables.test.ts`; web
  `lib/notebooks/variables.test.ts`; guide text.
