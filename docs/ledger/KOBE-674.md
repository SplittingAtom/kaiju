# KOBE-674: Flaky server db tests (memory-selection 429, retention lock "busy")

- **Status:** in review (committed locally on `kobe-674-flakes`; coordinator opens the PR)
- **Branch / worktree:** `kobe-674-flakes` in `../Kobe-wt674`
- **Depends on:** none. Test-only change; no product behaviour change.

## Finding: db test files do not share a database

The brief assumed CI runs db files against one shared database, so Site-wide rows and advisory
locks leak between files. They don't: `createTestDatabase()` (`@kobe/db/testing`) gives every
`openHarness()` and `EventStreamFixture` its own `kobe_test_<suffix>` database, and Postgres
advisory locks are per database. Site rows can only leak between tests **of the same file** (the
#617 near-duplicate came from a Site memory approved earlier in that file). Both flakes here are
in-file races.

## Causes and fixes

1. **memory-selection › stable_plus_delta** (run 44491233872, attempt 1). The log says
   `Error: upgrade refused: 429` at `memoryOf` (line 644), not an assertion. Every fake sandbox
   connects from 127.0.0.1, so the whole file shares one sandbox-wire upgrade bucket (production
   default burst 20, refill 2/s, `sandbox-wire/gateway.ts` `AttemptLimiter`). The file opens 26
   sandboxes; on a fast runner the 21st within ~0.5 s got 429. `sandbox-wire.db.test.ts` and four
   others already raise `upgradeBurst`/`upgradeRatePerSec` for this reason.
   **Fix:** `EventStreamFixture.setup` now defaults `sandboxWire.tuning` to `upgradeBurst: 1000,
upgradeRatePerSec: 100` (a file's own tuning still wins). This covers every fixture-based file,
   including the 58 that use `RunFixture`. No test exercises the upgrade limiter through the
   fixture (grep: no `upgradesRefused`/upgrade 429 assertions).
2. **retention › stops the pass when the lock connection fails** (run 44492154095, attempt 1):
   `expected 'busy' to be 'ran'`. After the simulated lost connection the job calls
   `client.release(true)`; pg ends that connection without waiting, so its backend (still holding
   the session advisory lock) can outlive `tick()` by a few ms, and the next `tick()` saw the lock
   taken. Reproduced with a probe (take lock, `release(true)`, try lock on a pooled connection):
   0/1500 on an idle DB, 4–8 of 300 per process with six probes in parallel (CI's loaded runner).
   Production is fine: a really failed connection's backend is already gone and the next check is
   minutes later. **Fix:** the test waits (≤5 s) until the lost client's backend pid has left
   `pg_stat_activity` before asserting `'ran'`. Assertions unchanged.

## Sweep

- Counted real sandbox connects per file (temporary counter in `FakeSandbox.connect`, reverted)
  over the 23 files calling it directly without upgrade tuning: memory-agent 26,
  sandbox-lifecycle 25, artifacts 23, thread-compact 21, remember-scopes 20, notebooks 15,
  sandbox-wire-limits 15, file-share 14, rest ≤11. All were at or over the burst; the fixture
  default fixes them all with one change.
- Only `retention/job.ts` takes `kobe.retention`; `startup-seeds.db.test.ts` runs a retention
  tick but in its own database, so no cross-file conflict. The other `pg_try_advisory_lock` users
  (model sync, reconcile lock, skills jobs) have no test that releases a lost lock and re-ticks.
- Left as is (in-file only, not flaky today): files that write Site-wide `site_settings`
  (`memory.settings`, `memory.enabled`) restore them in `finally`; 14 files do this
  (memory-selection, memory, memory-agent, memory-switches, kobe-mcp-team, …). Safe while each
  file has its own database and tests run sequentially within a file.

## Docs

No guide change: tests only, nothing a member, admin or agent sees.

## Evidence

- memory-selection.db.test.ts 10× in a row: 10/10 passed (18 tests).
- retention.db.test.ts 10× in a row: 10/10 passed (32 tests).
- Concurrency: memory-selection, retention, memory-agent, sandbox-lifecycle as four separate
  vitest processes at once, 3 rounds: 12/12 passed.
- 23 sandbox-connecting files in one run (`--maxWorkers=2`): 248/248 passed.
- `pnpm verify` (with `KOBE_TEST_DATABASE_URL`): exit 0; server db 263 files / 3277 tests passed.
