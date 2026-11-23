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
  - exact standard-library types (`type(v) is T`, never a subclass; classes compared by identity,
    never hashed), each safe because its text is library C or library code over fields checked
    to be plain: `datetime.date`/`timedelta`/`timezone` (C reprs over ints and an exact
    timezone); `datetime.datetime`/`time` only when `tzinfo` (read through the C getset) is
    `None`, an exact `datetime.timezone` or an exact `zoneinfo.ZoneInfo` (a member's tzinfo
    subclass would run its `utcoffset`/`tzname`/`__repr__`: type only then); `decimal.Decimal`
    (C repr over its own digits); `fractions.Fraction` rendered by Kobe from `_numerator` /
    `_denominator` read through the class's member descriptors and required to be exact `int`
    (else type only); `uuid.UUID` rendered by Kobe from its `int` slot (exact `int`, 128 bits);
    `pathlib.PurePosixPath`/`PosixPath`/`PureWindowsPath`/`WindowsPath` (pathlib's repr, only
    when `_raw_paths` holds exact strings); `Ellipsis`, `NotImplemented`; and inside containers
    exact `type` objects (qualname, C getset), built-in functions (`__name__`, C getset) and
    exact modules (`__name__` from the module dict) by name. Hostile variants (a recording tzinfo
    subclass, recording subclasses of each type, a Fraction with an `int`-subclass numerator)
    record zero calls and stay type-only (`inspect-source.test.ts` "exact standard-library
    values").
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
  and type, which the snapshot still sends. **Deploy order:** a server from before KOBE-816
  rejects `not_read` from a newer agent (the snapshot answers `unavailable`) until the server is
  updated, so servers deploy before sandbox images. From this change on the protocol accepts any
  short lowercase `repr_error` (`^[a-z_]{1,32}$`) and the web shows unknown ones as "not shown",
  so a later reason needs no ordering.
- **A member's timer:** unlike completion (which refuses while one is pending), the snapshot
  does not refuse: it runs nothing of the member's and no signal of its own; a member's signal
  handler can run whenever the kernel handles any message, this one included.
- **Docs:** `docs/guide/files/notebooks.md` (Variables: what is shown, what never runs, bounds);
  OpenAPI description (`openapi/notebook-variables.ts`). No "For agents" change (agents never see
  snapshots).

## Release notes (for the docs ticket)

- The Variables tab no longer runs any of your code to show values: your own classes and other
  libraries' objects (apart from NumPy and pandas) show their type only; standard-library dates,
  times, decimals, fractions, UUIDs and paths still show their value.
- Upgrade order: update the server before the sandbox image (an older server cannot read the new
  "value not shown" reason and answers "did not answer in time" until it is updated).

## Open questions (for Chris or the coordinator)

- Third-party objects other than NumPy/pandas (polars frames, Arrow tables) show the type only.

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
