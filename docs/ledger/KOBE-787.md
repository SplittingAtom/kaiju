# KOBE-787: Memory and embeddings leftovers (P2-47, P2-48, per-user learn-pass lock)

- **Status:** in review (group 74, branch `group-74-memory-write-paths`)
- **Branch / worktree:** `group-74-memory-write-paths` in `../Kobe-g74`
- **Depends on:** KOBE-779 (same branch)

## Plan

Checked each finding against main (a303f342) first.

- **P2-47 held.** `routes/memory-settings.ts` called `memoryVectors.start()` right after
  `invalidate()`; a running job answered `running` (ignored), then stopped at its next batch with
  `model_changed`, so nothing built the new model. `invalidate()` was replica-local; other
  replicas served the old model until a read past the 10 s TTL (stale-while-revalidate).
- **P2-48 did not hold as a bug.** `teamCurators` (memory/items/limits.ts) does list deactivated
  Team admins/stewards, but the only use, `notifyMemory` → `notifyOne`
  (notifications/memory.ts `isActiveMember`, KOBE-645), skips anyone deactivated or no longer a
  member, and team scope returns no after-commit recipients. A regression test was added
  (`memory-items-limits.db.test.ts`: a deactivated Team admin and steward hear nothing); it
  passed on unchanged code, so no code change.
- **Learn-pass daily count held.** `passesToday` ran under the thread lock only, so starts on two
  threads (two replicas) could both count N-1.

## Decisions

- **Build carries on with a new model.** `VectorBackfill.#run` loops: after a pass that finished
  or stopped with `model_changed`, it re-reads the usable model and, when it differs, runs again
  with it (job `model` updated, `embedded` reset). A removed model still stops it. Covers the
  other-replica case too (the lock holder restarts itself).
- **Cross-replica cache invalidation.** `writeMemorySiteSettings` sends
  `pg_notify('kobe_memory_settings', 'embedding_model')` in its transaction when the model changed
  (every writer, delivered at commit). `MemoryEmbeddings` takes the shared `ListenClient`
  (`pg-listen.ts`) and subscribes on its first `model()` read (nothing is cached before; no eager
  LISTEN for tests); `notification` and `listening` (reconnect) both `invalidate()`.
- **Per-person learn lock.** `lockPassStarts` (`pg_advisory_xact_lock` on
  `kobe.memory-learn-starts:<team>:<user>`) in `prepare`, after the thread lock and before
  `passesToday`, held through the claim. Lock order thread → person everywhere; a wait past the
  transaction's lock timeout answers `thread_busy` like the thread lock.
- **Guide:** memory.md Vectors: a model saved during a build carries the build on. The daily
  count and cache invalidation change nothing a person sees (the documented limit is now exact).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `memory-vectors-model-change.db.test.ts` (two replicas: replica 1 sees the new model well
  inside the TTL; a model saved mid-build ends with every item on the new model, job `done` on
  it); P2-48 regression test in `memory-items-limits.db.test.ts`.
- ac-2: `memory-learn-pass.db.test.ts` "two replicas cannot go past the daily count together"
  (failed before the lock: both starts ok).
