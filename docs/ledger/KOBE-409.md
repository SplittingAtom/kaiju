# KOBE-409: SMD2: pgvector hybrid retrieval

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress: migration PR #579; contract, gateway, server, web, harness and docs
  committed on `kobe-409-sm`; ac-1 numbers wait for a reachable embedding endpoint (gate1)
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

- **Site embedding model = a gateway model id** (`embedding_model`, replacing the unused
  `embedding_model_alias`): `kobe-local` has no `model_providers` row, so no catalog alias can
  name it (KOBE-659 ledger). Embedding models stay out of the catalog, so they are in no chat
  picker. The provider must be on the gateway (Site providers + `kobe-local` when the chart runs
  it); a removed provider shows as removed, never a fallback. The sync adds the model to every
  member's virtual key; the gateway skips the Workspace-enabled check on `memory_embed` only.
- **Gateway hardening:** a `memory_embed` token naming a run needs a live run of that thread
  owned by that member (queued/running/waiting/completed; `serverCallRunMatches({live:true})`);
  owner, not lease, since review M1 (the embedding starts before any lease exists).
- **Embed on save:** create, edit, revert, import (all scopes) via the item/transfer routes, in
  `BackgroundTasks` after the response; payer = saver + the Workspace they act in (none: skipped).
  Prefixes: nomic `search_document:`/`search_query:`, qwen3 query instruction (`prefixes.ts`).
- **Build vectors / re-embed:** `VectorBackfill` (site, portable, then each Workspace under its
  RLS), 64 per call, stops at the first refusal (budget, error) or a model change; started by
  saving a new model or `POST /v1/memory/vectors/build` (Site admin, their active Workspace).
  One job per replica; coverage comes from the database. Not audited separately (usage rows +
  the audited setting change; a new audit action would need a db registry change).
- **Hybrid selector:** the vector leg runs beside the keyword read on its own connection
  (`startVectorLeg`, RLS via `withTeam`, `statement_timeout` 30 ms), 32 nearest per lane of the
  query's model and dims; selection waits for it at most 45 ms from the start (query embed
  deadline 35 ms). Score += `VECTOR_WEIGHT · max(0, (sim − VECTOR_MIN_SIMILARITY)/(1 − min))`;
  similarity ≥ min makes a candidate without a keyword match. Constants (1.0, 0.5) in
  `select.ts`, to be tuned with the harness numbers (not Site settings: one fewer knob).
- **Perf** (this VM → LAN dev Postgres, scope limits, 768 dims on every row,
  `KOBE_PERF_STRICT=1`): keyword-only p50 33–35 / p95 52–54 ms (already over 50 here, LAN
  round trips); hybrid with the leg beside it p50 39 / p95 57 ms, leg answered 20/20. An earlier
  design (leg after the keyword read, in a savepoint) always timed out at 15 ms. The perf test
  bounds hybrid p95 by max(budget, keyword p95) + 10 ms.

- **Review fixes (2026-11-15, commits after 9983ac5f):**
  M1 the query embedding starts when the start is sent (`RunDispatcher.start` →
  `MemoryEmbeddings.prefetchQuery`) and again as delivery begins; selection takes the running
  promise, deadline 35 ms; per process (other replica: started at delivery); a run without lanes
  pays nothing (`runWantsVectors`); Site model/pgvector state served stale-while-refresh.
  M2 data flow stated in the memory guide, site-admin guide and the embedding field's hint.
  L3 refuses catalog chat models and ids missing from the provider's Bifrost list (no list:
  accepted). L4 gateway filters `GET /v1/models` to enabled models (fails closed, `model-list.ts`).
  L5 a late query vector reads no rows. L6 Build vectors holds advisory lock
  `kobe.memory-vector-build`; a second start is 409 `running`.
  Perf (this VM, LAN pg, strict): 150 ms embed + 250 ms wake → vector in time 20/20 (0/5 when
  started at selection); p95 80.6 ms vs keyword-only after the same pause 75.6 ms (idle
  connections are slower either way; back-to-back keyword p95 36 ms).
- **Rebase note:** `origin/kobe-409-sm-migration` has 2 newer commits (main merge + sink.test.ts
  fix); the coordinator rebases after the migration PR merges.

## Open questions (for Chris or the coordinator)

- ac-1 numbers: the Mac mini Ollama was not reachable from the GSD VM (TCP to 11434 closed) and
  there is no in-cluster embeddings Service yet, so the harness has not run against a real model.
  Run on gate1 (or anywhere that reaches one): `KOBE_EVAL_EMBED_URL=http://<host>:11434/v1
KOBE_EVAL_EMBED_MODEL=qwen3-embedding:0.6b e2e/memory-eval.sh relevance` (then
  `nomic-embed-text`, and the in-cluster nomic via a port-forward), then tune `VECTOR_WEIGHT` /
  `VECTOR_MIN_SIMILARITY` if hybrid does not beat 0.573.

## Evidence (acceptance criteria → test or command output)

- Migration: `packages/db/src/memory-vectors.db.test.ts` (with and without pgvector, late enable).
- ac-3: `services/model-gateway/src/server-call.test.ts` "memory embeddings (KOBE-409 ac-3)",
  `routes.test.ts`, `usage/meter.test.ts`; `packages/protocol/src/server-call-embeddings.test.ts`;
  docs/licensing.md pgvector note. Live-run check: `model-gateway.db.test.ts` "a live-run claim".
- ac-2: `services/server/src/memory-vectors.db.test.ts` (model state, notice data, embed on save
  billing, budget refusal keeps the save, Build vectors, hybrid vs keyword, other model ignored);
  `memory/embeddings/service.test.ts` (deadline, errors, no model); web
  `components/admin/memory-switches.test.tsx` "search by meaning" (pgvector missing, no model,
  coverage + Re-embed, gateway model saved).
- Perf: `memory-selection-perf.db.test.ts` (hybrid case; realistic embed latency case, M1).
- Review fixes: `memory/embeddings/service.test.ts` (M1 early start, L5), `runs/dispatch.test.ts`
  (embedding started before run.start), `memory-vectors.db.test.ts` (M1 prefetch, L3, L6),
  `model-gateway/src/gateway.test.ts` + `model-list.test.ts` (L4), `model-gateway.db.test.ts`
  (unleased live claim), web `memory-switches.test.tsx` (M2 hint).
- ac-1: harness hybrid mode `services/server/src/testing/memory-eval/relevance.eval.ts` +
  `embed-endpoint.ts`; numbers pending (see open questions).
- ac-4: docs/guide/memory.md (Search by meaning; /llms.txt is generated from it),
  docs/install.md (Vector search for memory), docs/design/server-model-calls.md.
