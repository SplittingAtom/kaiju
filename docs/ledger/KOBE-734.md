# KOBE-734: Migration runner commits each migration; non-transactional files (review STO-3)

- **Status:** in review (group 51, branch `group-51-storage-db`)
- **Branch / worktree:** `group-51-storage-db` in `../Kobe-g51`
- **Depends on:** none (KOBE-735 builds on it)

## Plan

Replace drizzle's `migrate()` (all pending migrations in one transaction) with a loop over the
journal that commits each migration with its bookkeeping row, and allow `-- kobe:no-transaction`
files for `CREATE INDEX CONCURRENTLY`.

## Decisions

- `packages/db/src/migration-runner.ts`; `runMigrations` calls it on the connection that holds the
  advisory lock, then (unchanged) memory vectors, schema lockdown and the grants step.
- Bookkeeping byte-compatible with drizzle: drizzle's own `readMigrationFiles` (same SHA-256 of
  the file, same `--> statement-breakpoint` split), same table DDL, `created_at` = journal `when`,
  same "newer than the newest recorded" rule. Test: after the runner, drizzle's `migrate()` finds
  nothing to do.
- Marker anywhere in the leading comment lines, so it can follow `-- kobe:hand-written` (which
  `db:rebase` requires on line 1). No change to `db:rebase` needed.
- No-transaction files are restricted to `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS` and
  `DROP INDEX CONCURRENTLY IF EXISTS`, one per breakpoint; checked before anything runs (and over
  every shipped migration in `migration-runner.test.ts`). Before each build the runner drops an
  INVALID index of that name (`DROP INDEX CONCURRENTLY`). The bookkeeping row is written after the
  last statement; a crash in between reruns the idempotent file.
- No-transaction statements run with `lock_timeout = 10min` (concurrent builds wait for older
  transactions but block no traffic); the runner's 10 s stays for everything else.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/migrate-runner.db.test.ts` "leaves 1..N-1 applied and recorded when N
  fails; a rerun continues" (hashes/created_at equal to drizzle's, drizzle's migrator agrees).
- ac-2: same file, "builds an index CONCURRENTLY" and "rebuilds an INVALID index left by an
  interrupted concurrent build"; refusal of a non-idempotent statement.
- ac-3: the k3d upgrade shard runs in CI (not runnable here). Locally: "continues an install
  that drizzle's migrator (earlier releases) migrated" (old runner's bookkeeping, then the new
  one applies only the rest), and the upgrade path of
  `createTestDatabase` (KOBE_TEST_BASE_MIGRATIONS = main's migrations, then this branch's) and the
  full db suites migrate through the new runner. `docs/development.md` "Migrations" says how to
  write a concurrent index migration; `docs/install.md` Migrations and `docs/parallel-work.md`
  updated.
- Guide (`docs/guide/`): no change, operators and developers only.
