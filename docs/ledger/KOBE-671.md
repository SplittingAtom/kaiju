# KOBE-671: Purge decided Workspace proposals and readers' suggestions with their pass

- **Status:** local commit on `kobe-671-sm` (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-671-sm` in `../Kobe-wt671`, from `origin/main` (5642c909).
- **Rule:** Gate B decision 12 (Chris, 2026-11-19). **Migration:** none.

## Plan

- `services/server/src/retention/memory-learning.ts` (KOBE-651's sweep): `purgePasses` also deletes
  the decided proposals/suggestions made from the doomed passes' candidates; new `purgeDecided`
  step for decided rows with no candidate ref, by `decided_at`. Both only when the Workspace has a
  window (`cutoff !== null`).
- Tests in `services/server/src/memory-learning-retention.db.test.ts`.
- Docs: `docs/guide/memory.md` (How long memories are kept › What Learn from this chat keeps;
  Legal holds), `docs/audit-log.md` (`retention.memory_learning_purged`).

## Decisions

- **Decided** = any state but `pending`: proposals approved/rejected/expired; suggestions
  approved/dismissed/expired (neither table has `withdrawn`; Workspace proposals never had it).
- **With the pass:** a finished pass past the window goes with its candidates and every decided
  proposal/suggestion whose `candidate_ref` points at one of them. The pass is skipped (and so are
  they) while a candidate is open, a pending proposal/suggestion shows one, or a hold covers the
  pass's person, a proposer/reader, or a decider (`decided_by`; none on an expired row). Keeping
  the pass keeps the rule "purged together".
- **Pass-less:** `candidate_ref IS NULL` (source `item`, or a candidate that already left with its
  pass or conversation, e.g. passes purged under 651 before this change) and `decided_at` older
  than the window; same hold checks.
- **Order (FK):** doomed passes selected `FOR UPDATE SKIP LOCKED` first; proposals and suggestions
  deleted in their own statements; then passes (candidates cascade). The candidates'
  `ON DELETE SET NULL (candidate_ref)` therefore never meets a row being deleted in the same
  statement. The 0229/0232 delete guards are satisfied because held people are filtered first.
- **Notices:** `memory_reminders` and `notifications` whose `memory_object_id` is a purged proposal
  or suggestion are deleted with it (as offboarding does), so no bell entry opens nothing. Pass
  reminders/notices are untouched (as in 651).
- **Audit:** existing `proposals` and `suggestions` count keys of
  `retention.memory_learning_purged` (already used by offboarding) now also count retention purges;
  no new keys needed, no ids.
- **Forever:** both steps run only with a cutoff; pending rows only expire (651).
- **Site memory proposals:** untouched (KOBE-666 owns `site-proposals.ts`).
- **Hold scope:** a Site-wide hold does not stop these sweeps (651's rule: it covers Site memories).

## Docs

- `docs/guide/memory.md`: what Learn from this chat keeps now names decided proposals/suggestions,
  pass-less ones by decision date, pending never deleted, record kept by versions + audit log;
  Legal holds bullet names proposals/suggestions a person made or decided. Summary line already
  covers "how long … proposals … are kept". `docs/audit-log.md` row updated. No UI change.

## Evidence

- **ac-1** `memory-learning-retention.db.test.ts` › decided proposals and suggestions (KOBE-671) ›
  "purges decided ones with their pass past the window, and pass-less ones by decision date":
  pass + approved/expired proposal + dismissed suggestion gone; recent pass keeps its rejected
  proposal; item proposals at 31 d gone / 29 d kept; pending kept; loose suggestions 45 d gone /
  20 d kept; bells removed; audit sums passes 1, proposals 3, suggestions 2; second run silent.
- **ac-2** same describe › "purges nothing while the Workspace keeps forever" and "keeps everything
  a held proposer, decider or reader is part of, with its pass" (person holds on proposer/reader
  and decider, Workspace hold, then release purges all).
- **ac-3** docs above.
- Tests written first (2 failed on main code), then 14/14 green.
