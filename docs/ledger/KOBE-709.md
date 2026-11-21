# KOBE-709: Server composition root; inline sweeps into the job registry; startServer() returns stop()

- **Status:** in review (group 65, branch `group-65-orchestrator-composition`)
- **Branch / worktree:** `group-65-orchestrator-composition` in `../Kobe-g65`
- **Depends on:** KOBE-708 (same branch, both touch `index.ts` and `deps.ts`)

## Plan

Review 2026-11-20 CODE-8. `services/server/src/index.ts` was a 771-line top-level script; it is
now a 20-line entry point: `startServer(loadConfig(process.env))`, and on SIGTERM/SIGINT
`stop()` then exit (1 when the user-facing listener failed to close or the stop hangs past the
drain timeout + 1 s, as before).

| File                      | Holds                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup/server.ts`       | `startServer(config, { env, log, listRuntimeClasses })` → `{ port, stop }`: isolation gate, deps, seeds, sandbox runtime, workspace sync bindings, skill services, lifecycle |
| `startup/server-deps.ts`  | env-derived settings, the scheduler's and API server's `createServerDeps` options, start-up warnings, the sealed-key check                                                   |
| `startup/process-jobs.ts` | `processJobs(ctx)`: every background job of the process, named, in start order                                                                                               |
| `startup/listeners.ts`    | user-facing, sandbox (+ wire) and internal listeners; their close with the drain timeout                                                                                     |
| `startup/jobs.ts`         | unchanged registry (`ServerJob`, `serverJobs`, `startServerJobs`); new `ProcessJob` base                                                                                     |
| `deps-options.ts`         | `ServerDepsOptions` moved out of `deps.ts` (re-exported; keeps `deps.ts` under 800)                                                                                          |

## Decisions

- **One job list.** The inline loops became named `ProcessJob`s in `processJobs`: `isolation`,
  `kobe-skills-seed`, `workspace-collector`, `external-scan-sweep`, `skill-mirror-sweep`,
  `skill-eval-hub`, `skill-eval-sweep` (its stop also drains running executions, review M2),
  `skill-eval-reaper` (advisory lock), the `serverJobs` registry entries, `team-reconciler`
  (advisory lock), `hibernation`, `pod-reconciler`, `scheduler`, `scheduled-run-hook`,
  `orbit-eval-sweep`. Intervals, locks and `.unref()` unchanged; the inline sweep error logs now
  go through `fireAndLog` with the same `<what> failed` messages.
- **Order.** Jobs start in list order, after the seeds and before the listeners (previously
  some started after `serve()`: nothing they do needs the listener). `stop()` calls every job's
  stop in list order (isolation first, as before), closes the listeners (sandbox abort, sandbox and
  internal close, event-stream hub, user-facing server with the drain timeout), waits for all job
  stops, then closes the deps (pools, LISTEN client, mailer) and telemetry. Previously job stops
  were not awaited before the pool closed; now they are (a stuck stop is still cut by the entry
  point's hard exit).
- **Out of scope:** retention internals (another branch); only how the pass is scheduled (it is
  still the `retention` server job). Routes, sandbox-wire, sandbox untouched.

## Docs

No `docs/guide/` change: start-up, shutdown and every job's schedule are unchanged for
members, admins and agents; this is an internal restructuring.

## Evidence (acceptance criteria → test or command output)

- ac-1: `startup/process-jobs.ts` `processJobs` lists every loop by name, start/stop order in
  one place.
- ac-2: `startup/server.db.test.ts` starts the API server (real Postgres, port 0, `/healthz` 200) and the scheduler, calls `stop()`, and finds no live timer or interval created during the
  run, no extra TCP handles and no app-role session left. Checked that it fails when one job's
  stop is a no-op (the `memory-learn-sweep` interval was reported).
- ac-3: `vitest run src/app.test.ts src/background.test.ts src/startup src/app.isolation.test.ts`
  5 files, 18 tests passed.
- Group verification: `pnpm verify` (no DB URL) exit 0; `pnpm --filter @kobe/server test:db`
  (`KOBE_DB_TEST_WORKERS=2`) 269 files, 3325 tests passed.
