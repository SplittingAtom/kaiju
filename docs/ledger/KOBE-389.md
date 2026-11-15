# KOBE-389: SMB1 Passes, candidates, watermarks, dismissals and team proposals schema

- **Status:** in review (local commits; not pushed)
- **Branch / worktree:** `kobe-389-sm` in `../Kobe-wt389`
- **Depends on:** KOBE-388 (Gate A; main bc236e00, migrations up to 0227)

## Plan

Migration ticket only (first Phase B migration, lands alone): schema
`packages/db/src/schema/semantic-memory-learning.ts`, generated `0228_memory_learning`, custom
`0229_memory_learning_rls`, tenancy `memory.ts` (5 team tables), probe fixtures, db test
`semantic-memory-learning.db.test.ts`. No services code.

## Decisions

- **New schema file** (`semantic-memory-learning.ts`, one `export *` line) instead of growing
  `semantic-memory.ts` (500 lines), per docs/parallel-work.md "new tables in new files".
- **Passes:** `thread_id` (cascade), `user_id` (author, NO ACTION), `branch_leaf_entry_id` NOT
  NULL, `from_entry_id` (null = from root / LCA), `to_entry_id` (required once completed); all
  three are composite keys into `thread_entries` of the same thread (entries only ever go with
  their thread). `model_alias`, `prompt_version` (text, 1..240), `status`, `usage` (object ≤ 4 KiB),
  `error` (exactly when failed, ≤ 2000), `started_at`, `finished_at` (exactly when
  completed/failed). Partial unique `memory_learning_passes_active_unique (team_id, thread_id)
WHERE status IN ('queued','running')`: one pass per thread whoever asks (team_id leads, as in
  every team index; a thread has one team so it is the brief's per-thread rule).
- **Candidates:** `pass_id` (cascade), `ord` ≥ 0 unique per pass, `payload` object ≤ 32 KiB (shape
  validated by the server), `state` (open|saved|proposed|suggested|dismissed|expired),
  `decided_at` exactly when not open, `expires_at` default now() + 14 days. Thread purge reaches
  them through the pass.
- **Dismissals:** PK (team, thread, user, statement_hash); hash = lowercase hex SHA-256 (CHECK);
  thread cascade.
- **Watermarks:** PK (team, thread, user), `entry_id` a key into `thread_entries` (cascade), so the
  ancestor/LCA walk over `parent_id` always starts from a real entry (ac-4 test runs that walk).
- **Proposals:** `source` (candidate|item) + `candidate_ref` / `item_ref`, keys into this
  Workspace's candidates / `semantic_memory_items` with SQL-only `ON DELETE SET NULL (column)`
  (drizzle can't express it). A proposal carries its own statement (≤ 500, as items), kind,
  rationale (≤ 1000), so a thread purge clears only `candidate_ref` and the curator's queue keeps it.
  `decided_at` exactly when not pending; `decided_by` exactly when approved/rejected (expired = no
  curator); `reason` only once decided. `expires_at` default now() + 30 days.
- **Sweep indexes (ac-2):** `memory_candidates_expiry_idx (team_id, expires_at) WHERE state='open'`,
  `memory_proposals_expiry_idx (team_id, expires_at) WHERE state='pending'`,
  `memory_learning_passes_finished_idx (team_id, finished_at) WHERE finished_at IS NOT NULL`.
- **RLS:** ENABLE + FORCE and the canonical `team_isolation` policy on all five; no
  break_glass_read (as the other semantic memory tables); no SECURITY DEFINER.
- **Legal hold:** thread-bound rows follow the thread (held thread never purged). Direct deletes
  are refused while a hold covers the pass's person (passes, candidates) or the proposer
  (proposals), skipping rows whose thread/pass already went in the same cascade. Dismissals and
  watermarks hold no content: no delete guard. TRUNCATE refused on all five.

- **`memory_learn` usage kind (coordinator, for KOBE-390):** added to `USAGE_KINDS` and the
  `run_usage_kind` CHECK in 0229 (NOT VALID, as 0192). A server call bound to the leaf's last
  completed run (KOBE-390 contract, PR #572): sandbox NULL, run_id set, like title/followups;
  0192's shape CHECK already covers it, so it is unchanged. `RUNLESS_USAGE_KINDS` stays
  `["skill_manifest"]`.

## Open questions (for Chris or the coordinator)

1. SM28 text was not available offline: proposals survive a thread purge (candidate ref cleared;
   statement + rationale stay). If SM28 wants proposals from a purged thread gone, switch
   `memory_proposals_candidate_fk` to CASCADE in a follow-up migration before KOBE-397 ships.
2. Candidate → saved item link is not stored (not in the brief); KOBE-39x can add `item_ref` if
   To review needs "Open saved item".

## Evidence (acceptance criteria → test or command output)

- ac-1: `probe.db.test.ts` (fixtures for all five tables) — see final run below.
- ac-2: `semantic-memory-learning.db.test.ts` "refuses a second queued or running pass" and
  "indexes open candidates, pending proposals and finished passes".
- ac-3: same file, "thread purge (ac-3, SM28)": passes, candidates, dismissals, watermarks gone
  with the thread, another thread's rows kept, the proposal kept with `candidate_ref` null.
- `memory_learn`: `usage.db.test.ts` "takes a memory_learn row as a server call bound to a run".
- ac-4: same file, "watermarks (ac-4)": FK to the entry, recursive ancestor walk true for leaf b,
  false for side branch c.
