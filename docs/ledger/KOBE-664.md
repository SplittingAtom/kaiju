# KOBE-664: SMD6: recall({query}) uses the hybrid (keyword + vector) scoring

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed locally on `kobe-664-recall-hybrid` (coordinator reviews + PRs)
- **Branch / worktree:** `kobe-664-recall-hybrid` in `../Kobe-wt664`
- **Depends on:** KOBE-409 (hybrid selector), KOBE-399 (recall over saved memories)

## Plan

1. Factor the selector's scoring so recall ranks with the same code: `rankRecall` (select.ts) and
   `recallCandidates` (run-memory.ts, built on the selector's `toCandidates`).
2. `MemoryEmbeddings.recallVector`: the selector's `#embedQuery` (same `memory_embed` token, same
   query prefix, same payer) with a recall deadline.
3. `recallItems(db, who, query, embedder?)`: keyword read in the team transaction, then the query
   embedding and the vector leg **outside** it, merge, rank.
4. Harness column, docs.

## Decisions

- **Same scoring, one place.** Candidates are built by the selector's `toCandidates` (trigram,
  similarity, `rankVectors` relative to the best similarity across lanes) and scored by
  `relevanceScore` (no preference base; stickiness forced off). Eligibility for recall:
  a keyword match, or `nearEnough` (top `VECTOR_MAX_ELIGIBLE` within `VECTOR_BAND`), the
  selector's own vector rule. Pinned items and person-lane preferences get no free pass (as
  before: recall needs a match). Matched Site Policy items rank like any lane (no vector leg,
  as the selector). Best `MEMORY_RECALL_MAX_ITEMS` (8).
- **No transaction across the model call.** The selector embeds outside its transaction (prefetch
  at message accept; the vector leg runs on its own `withTeam`). Recall does the same: transaction
  1 = plan + switches + keyword rows (commits), then the gateway call, then `readVectorRows` on its
  own `withTeam` (RLS as everywhere), then pure merge + rank. Nothing is embedded when the agent
  version has no semantic memory or no lane is on.
- **Deadlines.** Recall embeds on demand (no prefetch: the query is only known at the tool call),
  so it waits up to `RECALL_EMBED_DEADLINE_MS` = 3 s (capped by the purpose's 15 s server-call
  timeout), not the selector's 35 ms. The vector statement gets 1 s (`readVectorRows` gained an
  optional timeout; the selector keeps 30 ms).
- **Fallback = today's keyword answer** on: no embedder wired, no Site model, no pgvector columns
  (`usableModel` undefined), no vectors of the query's model (the leg returns no rows), a budget
  refusal (logged as a skip), a gateway error, the deadline, or a failing vector statement. The
  tool never fails for these; only a failing keyword read is logged and leaves items out (as before).
- **Charging (ac-3).** `#embedQuery` mints the `memory_embed` token naming the run and thread,
  paid by the run's member in the run's Workspace, refused at 100 % of a budget line, same
  `SERVER_CALL_LIMITS.memory_embed`. The sandbox still only sends `memory.read`; the embedding is
  server-side (no embeddings path in the sandbox).
- `show_memory_item`'s recalled bookkeeping is unchanged (connection keeps the answered ids).

## Open questions (for Chris or the coordinator)

- None blocking. A recall now costs one embedding call per `recall({query})` when a model is set
  (tiny; billed like the selector's).

## Evidence (acceptance criteria → test or command output)

- **ac-1** db: `memory-vectors.db.test.ts` "recall({ query }) finds a paraphrase with no shared
  word…" (fake gateway embedding by concept). Harness: `e2e/memory-eval.sh relevance` with
  `KOBE_EVAL_EMBED_URL` (LAN Ollama nomic-embed-text) now reports a "recall tool" column in both
  reports. No relevance numbers are recorded for this ticket: the run needs the LAN Ollama
  embedding URL, which the worktree sessions did not have; run it at the next gate review.
- **ac-2** unit: `service.test.ts` "recall query embedding (KOBE-664)" (no model, budget, error,
  deadline → undefined); `select.test.ts` "rankRecall"; db: same db test (no embedder, budget,
  gateway error, no model → keyword results, `ok: true`).
- **ac-3** db test asserts one `memory_embed` call with `run_id`, member and team claims.
- **ac-4** docs: `docs/guide/for-agents/working-in-a-sandbox.md` (Memory: recall),
  `docs/guide/memory.md` (recall tool list, Search by meaning, Who pays, What memory is not).
