# KOBE-737: Bundled CloudNativePG: pgvector on bootstrap, backup passthrough, production stance (STO-7)

- **Status:** in review (group 60)
- **Branch / worktree:** `group-60-storage-ops` in `../Kobe-g60`
- **Depends on:** KOBE-736 (`postgres.cnpg.parameters`, on main)

## Decisions

- **Image and pgvector (verified, not assumed).** The chart's `postgres.cnpg.imageName` is
  `ghcr.io/cloudnative-pg/postgresql:17`. Pulled on a remote amd64 Docker host on 2026-11-21
  (digest `sha256:70664ebcfa11…e8ea8e`, built 2026-08-31, PostgreSQL 17.11, Debian bullseye):
  package `postgresql-17-pgvector 0.8.6`, `vector.control` and `vector.so` present.
- `bootstrap.initdb.postInitApplicationSQL` runs, as the superuser in the kobe database, a `DO`
  block that creates `vector` in `public` only when `pg_available_extensions` lists it, so a custom
  image without pgvector still bootstraps (keyword-only search, as documented). The statement was
  run in a rolled-back transaction on the dev Postgres 17 (pgvector 0.8.7): it creates the
  extension. The migration Job calls `kobe_ensure_memory_vectors()` after every run, so the
  columns follow on the first install.
- Existing clusters: CloudNativePG runs bootstrap SQL once; install.md gives the one-off
  (`kubectl exec` into the primary, `psql -d kobe -c 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA
public'`, then `helm upgrade` to re-run migrations).
- `postgres.cnpg.backup` → `spec.backup` and (added, same pattern) `postgres.cnpg.plugins` →
  `spec.plugins`, verbatim, KOBE-736's passthrough pattern; schema: object / array of objects.
  `plugins` because CloudNativePG 1.26+ recommends the Barman Cloud plugin over the in-tree
  `barmanObjectStore`. ScheduledBackup stays the operator's resource (documented).
- Production stance (Chris, 2026-11-20): supported; install.md "Bundled Postgres
  (CloudNativePG)" says what to configure (backups, instances, storage size, parameters).
- **Migration 0230 comment left alone.** Its comment ("the chart's CloudNativePG bootstrap does it
  when the image has it") is now true. The runner hashes whole files (drizzle `sha256` of the SQL
  file), so the file is not edited in any case.

## Docs

`docs/install.md` (new "Bundled Postgres (CloudNativePG)" heading: pgvector, existing clusters,
production; pgvector section points to it), `docs/backup-restore.md` (PITR via
`postgres.cnpg.backup`). No guide change: operators only.

## Evidence

- ac-1: chart test `charts/kobe/tests/cnpg.test.ts` (bootstrap SQL rendered), image check and SQL
  check above. Not run: a k3d e2e with CNPG (CI has no CNPG e2e; would need the operator in k3d).
- ac-2: install.md one-off.
- ac-3: `cnpg.test.ts` (backup and plugins verbatim, absent by default, non-objects refused),
  `values.yaml`, `values.schema.json`.
- ac-4: install.md "Production".
