# KOBE-743: Storage chores: S3 single-request cap, workspace growth, plain-HTTP S3 warning, test leftovers

- **Status:** in review (group 60)
- **Branch / worktree:** `group-60-storage-ops` in `../Kobe-g60`
- **Depends on:** none

## Decisions

- **maxFileSize cap (STO-13).** Capped at 5Gi rather than adding multipart: the server config
  (zod refine in `sandbox/config.ts`, message names the S3 single PutObject/CopyObject limit) and
  the chart (`kobe.workspaceSyncConfig` fails the render with a clear message). JSON Schema cannot
  compare quantities, so `values.schema.json` only carries a description; the refusal is the
  template `fail`. `kobe.memoryBytes` learned `k` and `m` so it parses every quantity the schema
  accepts.
- **Workspace growth (STO-14): documented, not automated.** Patching PVCs from the team reconcile
  needs new RBAC (`list` PVCs, `get` StorageClasses cluster-wide), a StorageClass expansion check,
  team-quota headroom handling, and driver-specific behaviour for attached volumes (online vs
  offline expansion) that cannot be proven without a live cluster test: more than a small change.
  `docs/install.md` (Workspace storage, "Growing workspaces") gives the manual `kubectl patch`.
- **Plain-HTTP S3 (STO-17).** `plainHttpEndpointWarning()` (host only, never credentials) logged
  at server start next to the KOBE_PUBLIC_URL warning; install.md Object storage says so. No Site
  console notice (not cheap: needs a health route and UI; the log is the requested minimum).
- **Stale test databases (STO-16).** `test-support/sweep.ts`, run from `prepareTestLane()` (every
  DB suite's global setup) against `KOBE_TEST_DATABASE_URL` only. Drops a database only if its
  name matches `^kobe_(test|up)_[0-9a-f]{8}(_[a-z0-9]{1,20})?$`, its creation time (mtime of
  `base/<oid>/PG_VERSION`, superuser `pg_stat_file`) is over a day old, no session is connected,
  and a plain `DROP DATABASE` (no FORCE) succeeds; at most 100 per run, oldest first; errors only
  logged. Roles are not swept (cheap, and not in the ticket).
- **kobe-upgrade temp dirs (coordinator addition).** `upgrade.test.ts` removes its copies in
  `afterAll` and sweeps `kobe-upgrade-*` dirs older than an hour in `beforeAll`; the DB setup
  sweeps them too.

## Docs

`docs/install.md` (growing workspaces, plain-HTTP warning, maxFileSize cap), guide
`files/storage-limits.md` (site limit at most 5 GiB), `docs/parallel-work.md` (sweep).

## Evidence

- ac-1: `services/server/src/sandbox/config.test.ts` "refuses a maxFileSize over S3's 5 GiB";
  `charts/kobe/tests/sandbox.test.ts` "syncs workspaces ... with limits" (5.5Gi, 6G, 1Ti refused).
- ac-2: documented (install.md "Growing workspaces").
- ac-3: `workspace-sync/s3.test.ts` "plainHttpEndpointWarning"; install.md Object storage.
- ac-4: `test-support/sweep.test.ts` (selection rules: names, age, sessions, cap; temp dirs) and
  `sweep.db.test.ts` (real creation time and sessions; drop refused while connected; only its own
  database is ever dropped). First run on the dev server: "dropped 100 stale test database(s)".
- Upgrade temp dirs: `kobe-upgrade-*` count in TMPDIR 0 before and after `upgrade.test.ts`.
