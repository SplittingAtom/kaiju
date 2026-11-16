# KOBE-409: SMD2: pgvector hybrid retrieval

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress: migration PR #579; contract 043c2d90 and gateway route 4b19b04f committed
- **Branch / worktree:** `kobe-409-sm` in `../Kobe-wt409`
- **Depends on:** KOBE-408 (earned: recall@8 0.573), KOBE-659 (in-cluster embedding model)

## Plan

1. Migration alone (`0230_memory_vectors.sql`, custom): optional pgvector columns, CI Postgres.
2. Contract: `memory_embed` server-call purpose + `POST /v1/embeddings` limits (protocol, own PR).
3. Gateway route `POST /v1/embeddings` for server-call tokens only.
4. Server: Site embedding model setting, embed on save, backfill/re-embed jobs, hybrid selector
   with a vector-leg deadline, FTS-only notice; harness offline mode; docs.

## Decisions

- **Columns on the three version tables, SQL-only** (`embedding vector` without a fixed dimension,
  `embedding_model`, `embedding_dims`, CHECK that they go together and `vector_dims` matches).
  Not in the drizzle schema: they exist only where pgvector does; the server detects them.
- **pgvector is not a trusted extension** and the migration role is never a superuser, so the
  migration creates the extension only when allowed; otherwise a superuser runs
  `CREATE EXTENSION vector` once and the next migration run adds the columns
  (`kobe_ensure_memory_vectors()`, invoker rights, EXECUTE revoked from PUBLIC, called by
  `migrate.ts` after every run). Without pgvector the migration succeeds and logs a notice.
- **Immutability:** `semantic_memory_versions_immutable()` now lets an UPDATE through when only
  the embedding columns change (all three tables); the app role gets column UPDATE on the
  site-wide version tables (tenancy `columnGrants`, granted only where the columns exist).
- **`run_usage` kind `memory_embed`** in the same migration (NOT VALID, as 0192/0229): a server
  call with no sandbox, with a run (the selector's query embedding at run start) or without one
  (saves, backfill, re-embed). Route stays `openai`.
- **No vector index** (RLS defeats it as with GIN; per-Workspace sets are small; variable dims).
- **Test databases** enable pgvector as the superuser when the server has it (`vector: false`
  for the no-extension path). **CI:** db-server shards install `postgresql-17-pgvector` from PGDG
  into the official `postgres:17` image (`scripts/ci-postgres.sh --pgvector`); db-core keeps a
  Postgres without pgvector, so migrations and the probe suite are proven there too, and the
  vector-path tests in `packages/db` skip with a logged reason.
- **Licensing:** docs/licensing.md note; inventory row `pgvector` marked `pending: gate review`.

- **Billing (coordinator, 2026-11-15):** query embedding = the run's member and Workspace (run_id
  set); embed on save = the person saving, in the Workspace they act in (Site console: the admin's
  current Workspace; portable: the owner where they saved); backfill/re-embed only when a Site admin
  saves the model setting or presses the action, charged to that admin and Workspace; nothing
  auto-runs after an upgrade (notice + action). 100 % budget skips the embed, never the save.
- **Contract:** `memory_embed` uses `/v1/embeddings` only; its run ids are attribution only (the
  run is still starting, so no completed-run check); output cap 1 (schema minimum), allowance 0.
- **Gateway:** the route is classified only for server-call requests (sandbox: 404); the usage
  meter charges no output for embeddings.

## Open questions (for Chris or the coordinator)

- none yet

## Evidence (acceptance criteria → test or command output)

- Migration: `packages/db/src/memory-vectors.db.test.ts` (with and without pgvector, late enable).
- ac-3: `services/model-gateway/src/server-call.test.ts` "memory embeddings (KOBE-409 ac-3)",
  `routes.test.ts`, `usage/meter.test.ts`; `packages/protocol/src/server-call-embeddings.test.ts`;
  docs/licensing.md pgvector note.
