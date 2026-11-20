# KOBE-735: Indexes for foreign keys checked on thread/run purge; redundant index drops (STO-4, STO-15)

- **Status:** in review (group 51, branch `group-51-storage-db`)
- **Branch / worktree:** `group-51-storage-db` in `../Kobe-g51`
- **Depends on:** KOBE-734 (no-transaction migrations)

## Plan

Catalog test first (it listed 12 uncovered foreign keys), then the indexes in the drizzle schema,
`db:generate`, and the generated SQL rewritten into the concurrent form.

## Decisions

- **Coverage rule** (`catalog.db.test.ts`): an index covers a key when its leading columns are
  the key's columns, or it is unique with all columns in the key (e.g. `threads_leaf_entry_fk`
  via the threads primary key), or the key points at `thread_entries` and the index leads with
  `(team_id, thread_id)` (entries go with their thread; one thread's rows are few). Partial
  indexes count only with a `col IS NOT NULL` predicate. With that rule the learning tables and
  `answer_feedback` (entry keys) were already covered; six indexes were missing.
- **Six indexes, not four:** the review's four (files and artifact_versions run keys, approvals
  and workspace_sync_conflicts thread keys) plus `sandbox_commands` and `sandbox_run_leases`
  thread keys (small transient tables; the test would fail without them).
- **Two migrations, both `-- kobe:hand-written`** (so `db:rebase` keeps the SQL and snapshots):
  `0236_fk_covering_indexes` (`-- kobe:no-transaction`: six `CREATE INDEX CONCURRENTLY IF NOT
EXISTS`, `DROP INDEX CONCURRENTLY IF EXISTS thread_app_results_thread_idx`) and
  `0237_drop_artifact_versions_unique` (transactional `ALTER TABLE ... DROP CONSTRAINT IF
EXISTS`: a constraint cannot be dropped concurrently, and the runner allows only index
  statements in no-transaction files). Snapshots from `db:generate` in two steps, not edited.
- **`events_schedule_fire_uniq` left as it is:** no migration backfills `events.schedule_id`
  (0098 says "No backfill"; nothing later sets it), so rows written before KOBE-252 have it
  NULL and a unique index on the typed column would not dedupe against them. Moving needs a
  backfill first (its own ticket).
- `approvals_thread_fk` kept (alternative was dropping it, the run key also cascades); an index
  is the smaller change.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `drizzle/0236_fk_covering_indexes.sql`, `0237_drop_artifact_versions_unique.sql`;
  `db:generate` reports no schema changes; `migration-runner.test.ts` checks the no-transaction
  file; catalog test also green on the upgrade path (KOBE_TEST_BASE_MIGRATIONS = main's
  migrations, then 0236/0237 through the new runner).
- ac-2: `catalog.db.test.ts` "every foreign key to threads, runs or thread_entries has a
  covering index" (red before: 12, then 6 after the rule) and "catches an uncovered one".
- ac-3: full `@kobe/db` db suite (probe suite) and `@kobe/server` db suite (retention tests).
- Docs: `docs/install.md` upgrade note. Guide (`docs/guide/`): no change, nothing users see.
