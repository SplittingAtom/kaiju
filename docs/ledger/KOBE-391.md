# KOBE-391: SMB3 — model gateway enforces the memory_learn purpose

- **Status:** in review (commit on `kobe-391-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-391-sm` in `../Kobe-wt391`, rebased on main 339a52a7 (after KOBE-389,
  399, 659, 394)
- **Depends on:** KOBE-390 (merged #572), KOBE-389 (merged #574: usage kind, pass table).

## Plan

Gateway-side only, no new routes, no migration. Most of the purpose is already generic (KOBE-234
server-call path keyed by `SERVER_CALL_LIMITS[purpose]`); add what is specific to a learning pass
and the two gateway-side review notes from KOBE-390.

## Decisions

- **Author-only run check.** `ServerCallRunClaim.authorOnly` (packages/db `serverCallRunMatches`):
  also requires `threads.owner_user_id = user_id`. The gateway sets it for purposes that name a
  pass (`serverCallNamesPass`, i.e. `memory_learn`); other purposes' claims are unchanged (the key
  is only added when true). A shared thread's other member is refused even on their own run (403
  `server_call_run_mismatch`, message names the author).
- **Fixed temperature** generalised: `FIXED_TEMPERATURE_PURPOSES = [eval_judge, memory_learn]`,
  each must send exactly its `SERVER_CALL_LIMITS` temperature (0).
- **Catalog output clamp.** `GatewayPrincipal.outputCaps` (server calls only: the smallest catalog
  `max_output_tokens` per enabled model), `Resolution.outputCaps` map; `checkServerCallBody` takes
  it and, for `CATALOG_CLAMPED_PURPOSES = [memory_learn]`, caps with `serverCallOutputCapFor`.
  Older purposes are not clamped: the server still mints them with `serverCallOutputCap` (title's
  512 reasoning cap could exceed a 256 catalog cap and would start failing).
- **Bytes as well as characters** (390 review): the per-purpose body cap is bytes
  (`serverCallBodyLimit` → 384 KiB, 413), so a message within 300 000 characters but over 384 KiB
  in UTF-8 is refused; tested both as a unit and over HTTP. No separate per-message byte cap.
- **No silent kind fallback** (390 review): `usageRecordOf` returns no row for a purpose that is
  no usage kind (`unrecordablePurpose`), whatever `eval` says; `DbUsageSink.record` logs an error
  ("dropped its model usage record"). Authentication already refuses such purposes, so only a bug
  reaches it; the budget reservation then expires by its TTL (conservative, never undercounts).
- Model check: unchanged generic path — `body.model === claims.model`, enabled for the Workspace
  (403 `model_not_enabled`), no fallback (`fallbacks` refused by the server-call schema).
  Nothing names a model.
- 100 %: `skip_at_percent: 100` → no soft limit; the ordinary stop (402 `budget_exhausted`).
- **Pass check** (after the rebase on 389): `ServerCallOptions.passRunning` (required, fail closed)
  → packages/db `serverCallPassRunning`: the token's `pass_id` is a `memory_learning_passes` row of
  the token's team, thread and user with status `running`; else 403 `server_call_pass_mismatch`.
  Runs after the author-only run check, before budget admission. The pass table has no run
  column, so "belongs to the run" is the same thread + the author-only run check.
- Not checked by the gateway: that the run is the _leaf's last_ completed run (the pass stores the
  leaf entry, not a run; mapping leaf → run is the server's job when it mints).
- The conditional `runIf`/`skipIf(isUsageKind("memory_learn"))` tests that waited for 389 are gone;
  everything runs unconditionally.

## Evidence

- **ac-1** `server-call-learn.test.ts` (message chars, ≤4 messages, byte cap, temperature, own
  format, token/purpose/reasoning/catalog output caps); `budget-gate.test.ts` "refuses a learning
  pass only at 100 %"; `server-call.test.ts` "the learning pass (KOBE-391)": catalog clamp, 413,
  402 over HTTP.
- **ac-2** `server-call.test.ts`: >30 s token can't be minted, expired refused, session/run
  token refused as a server-call token or beside one; non-author run 403 with `authorOnly: true`.
  `model-gateway.db.test.ts` "the run check admits the thread's author only" (real Postgres).
  Pass check: `server-call.test.ts` "refuses a token whose pass is not running…";
  `model-gateway.db.test.ts` "the pass check admits a running pass…" (wrong id, other thread,
  other member's pass, completed, failed, other team) and the end-to-end call (unknown pass 403,
  running pass 200 + `kind = memory_learn` row).
- **ac-3** `server-call.test.ts` "refuses /v1/embeddings and every other route to a learning token".
- Sink: `usage/sink.test.ts` (no eval/run fallback; dropped + error log).
