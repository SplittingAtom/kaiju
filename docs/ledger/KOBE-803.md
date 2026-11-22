# KOBE-803: Python runs: timing, run log data and a variables snapshot over the sandbox wire

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the PRs)
- **Branch / worktree:** `group-84-python-run-wire` in `../Kobe-g84`
- **Depends on:** nothing. **Feeds:** KOBE-804 (Log/Variables tabs), KOBE-808 (completion).
- **Migration:** yes, `0242_notebook_inspect_command.sql` (adds `notebook.inspect` to the
  `sandbox_commands_kind` CHECK; generated). It is its own commit (first on the branch) so it can
  land as its own PR; rebase with `db:rebase` if another migration lands first.

## Decisions

- **Run log lives on the existing run events, no table.** `notebook.started` already says who
  (`origin: "user"` = the thread owner's Run, `"agent"` = `run_python` with `tool_call_id`) and
  `path`/`cell_id`. `notebook.finished` gains optional `timing` and `error`. The web store
  (`apps/web/lib/notebooks/executions.ts`) is unchanged; KOBE-804 reads the new fields. The server
  parses the agent's result leniently: the core decides the execution; an unknown field or a bad
  `timing` is dropped and logged, never failing the run (review M2).
- **Variables are never stored** (review M1, coordinator's decision): not in run events (share
  readers, 7-day retention, legal holds), no audit of values (the route logs only that a snapshot
  was asked for). A repr can hold a secret the member never printed, so snapshots go to the thread
  owner only, on demand, through the route, and never to the model: `run_python` never asks for
  one (`with_timing` only).
- **Error name and line are computed on the server** from the stored error output
  (`services/server/src/notebooks/run-log.ts`), so they work with older agents too. The line is the
  innermost `Cell In[N], line L` (or `"<ipython-input-N-…>", line L`) whose N is this execution's
  count, i.e. the line in the cell or `.py` file that ran; frames of earlier cells are ignored.
- **Timing is measured by the agent** around the bridge call (wall-clock ISO instants for display,
  `performance.now()` for `duration_ms`); absent when the code never ran (dropped, timed out
  waiting) or the agent is old.
- **Snapshot mechanics (kernel side, `images/sandbox/kernel/kobe-kernel-bridge.py` `inspect`).**
  An empty execute request with `silent=True, store_history=False` and one `user_expressions`
  entry: `silent` means no execution-count bump, no iopub output, nothing in `Out`/`_`/`In`. The
  expression execs `INSPECT_SOURCE` in a fresh dict (the user's namespace gets nothing) and returns
  JSON text; the bridge `literal_eval`s IPython's `text/plain` repr of it. Each variable is
  described under `signal.setitimer(ITIMER_REAL)` (200 ms) with every exception caught (except
  `KeyboardInterrupt`), so a raising/looping/sleeping/`SystemExit` repr costs only that variable
  (`repr: ""`, `repr_error`); a whole-snapshot budget (2 s), 200 variables, 64 KiB and 200-char
  reprs cap it (`truncated`). Types come from `type()` and the type slots, never `__class__`;
  numpy/pandas only via `sys.modules` (never imported); DataFrame/Series give shape, columns and
  dtypes, never data. Alarms are skipped when the user has a timer pending (budget still applies).
  Subclasses of built-in containers/strings/bytes get the bounded repr too (base type's
  `__len__`, reprlib handlers or a slice), never their own `repr()` (review L1).
- **Agent side.** After a member's run (`with_variables`) the agent takes a snapshot in that
  execution's slot (3 s cap; not after a timeout or lost kernel) and keeps it in memory with the
  kernel (replaced each time, gone on restart/idle stop/hibernation). `KernelManager.inspect`
  never starts a kernel (`no_kernel`); while code runs or waits it answers the kept snapshot with
  `stale: true` (or `busy` without one); when idle it answers the kept one (`stale: false`) if
  nothing ran since and no `refresh`, else takes a fresh one (kept in turn); past its timeout
  `unavailable` (SIGINT to the kernel). An execution never waits on a snapshot: it interrupts one
  still running and, if it has not ended within the grace (5 s, or the deadline) or Stop arrives,
  the execution returns `restarted` (kernel stopped) or `interrupted` (review L1).
- **Wire compatibility.** Capability `notebook_inspect`. Stored `notebook.execute` rows (member
  runs) carry no asks: the delivering replica adds `with_timing` + `with_variables` for a capable
  agent (`withMemberRunAsks`), so an older replica in a rolling deploy still delivers rows a newer
  one queued (review L2). `run_python` sends `with_timing` on its own connection; it is dropped for
  agents without the capability (`withNotebookAsks`). A new agent only adds `timing` when asked.
- **Rolling deploy limitation (accepted):** an older replica holding the sandbox connection can't
  read a `notebook.inspect` row: it fails it `invalid_command`, which the route answers as 409
  `variables_unsupported` ("not available yet"); other new command kinds (`thread.context`) behaved
  the same, there is no skip mechanism. It ends when the deploy completes.
- **Gate.** `notebook.inspect` is a server→sandbox _command_, not a sandbox tool frame (no
  `tool_call_id`), so it is not in `ToolFrameSpecs`; the command gate is delivery preflight: it is
  in `NOTEBOOK_COMMANDS` (needs `notebooks`, never an eval sandbox) and also needs
  `notebook_inspect` (`inspect_unsupported`). The route is decided like the Run/start routes:
  `team.chat`, eval threads refused (`skill_eval_thread`), owner only (`read_only`/404),
  `assertMayRun`, isolation present, rate limit 60/min/member. `tools.allow` is an agent-run
  policy; member-started kernel actions (Run, start, interrupt) do not consult it today and this
  route follows them. The after-run snapshot rides on a member's run that was already allowed.
- **Never wakes.** The route answers `no_kernel` without a live connection, and the router sends
  `notebook.inspect` with the new `SendOptions.wake: false`: if the connection vanished between
  check and send, the command fails `sandbox_not_connected` at once instead of waking.
- **No GET.** The route serves the kept snapshot (cheap, no kernel call) or a fresh one; the
  `run_python` text the model gets is unchanged.
- **Docs:** no guide change. Nothing member-visible until KOBE-804 builds the tabs (it should add
  a short note to `docs/guide/files/notebooks.md`); `run_python` results are unchanged for the
  agent, so the "For agents" pages stay as they are. OpenAPI documents the route.

## Shapes for KOBE-804 (UI) and KOBE-808 (completion)

Contract: `packages/protocol/src/notebook-variables.ts` (+ `notebooks.ts`).

- `notebook.finished` payload (run events, the Log tab): `{exec_id, status, execution_count,
outputs, truncated, saved, save_error?, timing?: {started_at, finished_at, duration_ms}, error?:
{name, line?}}`. `timing` absent = older sandbox or code that never ran. No variables here.
- Variables tab: call `POST /v1/threads/{id}/notebook/variables` after each run's
  `notebook.finished` (no body: the snapshot the agent kept after that run) and on Refresh
  (`{"refresh": true}`: a fresh one when idle) → 200 `<VariablesResult>`; show `stale` /
  `taken_at` ("as of …, code has run since"); errors
  `{code, message}`: 409 `variables_unsupported` (older agent: show "not available yet"),
  409 `notebooks_unsupported`, 409 `skill_eval_thread`, 403 `read_only`, 404 `thread_not_found`,
  429 `rate_limited`, 503 `isolation_unavailable`/`sandbox_unavailable`.
- `<VariablesResult>` = `{status: "busy" | "no_kernel" | "unavailable"}` or
  `{status: "ok", taken_at, execution_count, truncated, stale?, variables: Variable[], other: {name, kind:
"module"|"function"|"class"}[]}`, sorted by name. `Variable` = `{name, type, module?, repr,
repr_error?: "raised"|"timeout", len?, shape?: number[], dtype?, columns?: {name, dtype}[] (≤50),
columns_total?}`. Reprs are untrusted text.
- Wire (agent): `notebook.inspect {command_id, thread_id, timeout_ms?, refresh?}` → `command.result.data` =
  `<VariablesResult>`. KOBE-808 can follow the same pattern for completion: a new
  capability, a command kind (migration) or an op, a bridge op using `complete_request` on the
  shell channel (it does not bump the execution count either), `busy` while executing.

## Open questions

- Should the member's variables route also honour a team-level "no Python" policy if one is added
  later? Today no policy covers member-started kernel actions.

## Evidence

- ac-1: `services/sandbox-agent/src/notebook/manager.variables.test.ts` (timing),
  `services/server/src/notebook-variables.db.test.ts` (stored on `notebook.finished`; a newer
  agent's unknown field / bad timing dropped, execution kept).
- ac-2: `notebook-variables.db.test.ts` "the run log" (member run; new and old agent),
  `services/server/src/notebooks/run-log.test.ts` (error name/line); `run_python` uses the same
  `finishExecution` path (`notebooks.db.test.ts` still green).
- ac-3: `services/sandbox-agent/src/notebook/inspect-source.test.ts` (plain Python through the
  bridge's own expression: raising/looping/sleeping/exiting/huge reprs, numpy/pandas summaries
  simulated when not installed, caps, budget), `manager.variables.test.ts` (busy, no_kernel,
  unavailable, kept/stale/refresh, stuck snapshot vs. a run and Stop), subclasses, real kernel: `images/sandbox/test-image.sh` new check; run by hand against
  ipykernel 7.4.0 + pandas 3.1.0 + numpy in a python:3.12-slim container: `ok 1 True (5,1) raised
timeout [3, 4] float64 [2, 2] a:int64,b:str 5 Bad:class,Slow:class,np:module,pd:module`.
- ac-4: `agent.notebooks.test.ts`, `delivery/notebook-inspect.test.ts` (asks added at delivery,
  rows carry none), db tests "older agent"; `notebooks.db.test.ts` (`run_python` asks timing only).
- ac-5: protocol `notebook-variables.test.ts`; OpenAPI (`openapi.json`, `openapi/notebook-variables.ts`)
  and `route-inventory.app.txt` (one new line).
