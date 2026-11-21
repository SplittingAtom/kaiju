# KOBE-724: Tests: replace fixed sleeps with condition waits / fake timers in the flakiest files (review CODE-30)

- **Status:** in review (group 58, branch `group-58-flaky-tests` in `../Kobe-g58`)
- **Depends on:** none

Rule followed: for each flake, product race or test race decided from the code; no timeout raised,
no sleep or retry added, no assertion weakened.

## Merge-queue flakes

### `packages/db/src/budget-reservations.db.test.ts` "an expired reservation does not count…" — test race

CI run 44879763740: `expected 'ok' to be 'full:0'`. `kobe_reserve_budget` (latest body in
`drizzle/0152_reserve_full_holds.sql`) judges every hold under the team advisory lock with
`expires_at > clock_timestamp()` in one statement, and writes `expiry` from the call's TTL. Expiry
is a wall-clock TTL by design (a crashed replica's hold lapses by itself); at the boundary a hold is
either live or not at that statement's clock: no race in the function. The test reserved with a
**100 ms** TTL and expected the _next_ call to still see it: on a loaded runner the second call came
more than 100 ms later, the hold had legitimately expired, and the reserve returned `ok`.
Fix: the hold is reserved with the default 60 s TTL (so `full:0` is certain), then its `expires_at`
is set explicitly to one second ago (inside the minute before the reserve-time sweep removes it);
the next reserve is `ok` and the expired row is checked by its call id (stronger than the old
"more than one row" count). No sleep.

### `services/model-gateway/src/budget-gate.test.ts` "holds a settled reservation…" — test race

The heartbeat is `setInterval(extend, heartbeatMs)` in `BudgetGate.releaser`, cleared on release;
the release of a written call extends once more. Correct. The test used real 10 ms intervals and
expected at least two beats inside a 60 ms real sleep: when the event loop is starved (full
`pnpm verify`), Node runs an overdue interval once and then the overdue 60 ms timeout, so one beat
is seen. Fix: fake `setInterval`/`clearInterval` for that test; exact counts (3 beats in 30 ms,
+1 on release, none in the next 1 000 ms).

## Fixed sleeps (CODE-30)

All test races (the sleeps stood in for a condition or a "does not happen" window); product code
unchanged.

- `services/server/src/trace-spans.db.test.ts` (8 sleeps): sandbox span frames are handled
  synchronously on receipt (`connection.ts` `#onTraceSpans` → `TraceIntake.accept`), and each frame
  moves the wire counters (`traceFramesDropped`, or per span `traceSpansRelayed`/`traceSpansDropped`).
  "Nothing exported" checks now wait until the counters show the frames handled, then flush the
  relay and assert; the late-frame test waits for `runsCompleted` (the run's lease ended) instead
  of 200 ms; polling loops became `vi.waitFor`.
- `services/sandbox-agent/src/notebook/manager.test.ts` (9): the fake bridge records each cell it
  runs (`control.executed`); "the cell is running" waits on that, "the idle kernel stopped" waits on
  `control.killed`. The package's `until` moved to `src/testing/until.ts` (re-exported by the
  harness) so unit tests use it without the harness.
- `services/server/src/event-stream/stream.test.ts` (7): epilogue "still open" checks read
  keep-alives until the stream has re-read the log once more (a re-read is what would end it);
  read-ahead check on fake timers; slow consumer and in-flight read via `vi.waitFor`; the 1 s race
  guard dropped (the stream must end inside the test's timeout, long before the 60 s periodic
  recheck); the writer's 1 ms pacing is a `setImmediate` yield.
- `services/model-gateway/src/gateway.test.ts`: not touched (being split on another branch).

### Skipped: `apps/web` `rail-pickers.test.tsx`, `rail-tabs.test.tsx`, `app-context.test.tsx`

Most of their sleeps are "nothing was sent / no second save" windows across assistant-ui's async
send path and the debounced preferences save. A deterministic version needs fake timers that
Testing Library's `waitFor` and user-event cooperate with, which means changing the shared setup
(`apps/web/vitest.setup.ts`, off limits: changed on another branch) or the chat test helpers being
refactored now. Left for a follow-up once those branches land.

## Docs

No `docs/guide` change: tests only.

## Evidence

Consecutive single-file runs (all after the change):

| File                                                  | Alone | Beside another db file                                  |
| ----------------------------------------------------- | ----- | ------------------------------------------------------- |
| `packages/db/src/budget-reservations.db.test.ts`      | 30/30 | 1/1 (beside memory-learn-pass, and beside the 770 loop) |
| `services/model-gateway/src/budget-gate.test.ts`      | 30/30 | n/a (unit)                                              |
| `services/server/src/trace-spans.db.test.ts`          | 30/30 | 1/1 (beside the budget-reservations loop)               |
| `services/sandbox-agent/src/notebook/manager.test.ts` | 30/30 | n/a (unit)                                              |
| `services/server/src/event-stream/stream.test.ts`     | 30/30 | n/a (unit)                                              |

Note: `services/sandbox-agent/src/models/runtime-dir.test.ts` fails 2 tests when `TMPDIR` is a
group-writable, non-sticky directory (it checks exactly that); it passes with the default
`TMPDIR`. Environment, not these changes.
