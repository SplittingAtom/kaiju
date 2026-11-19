# KOBE-668: Readers' suggestions: `stale` (thread moved) apart from `expired` (30 days)

- **Status:** in review (local commit on `kobe-668-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-668-sm` in `../Kobe-wt668`, based on `kobe-665-sm` (migration 0234
  in the merge queue; unchanged here).
- **Decision:** Chris, Gate B decision 13 (2026-11-19): separate states.
- **Migration:** `packages/db/drizzle/0235_memory_suggestion_stale.sql` (hand-written marker: drizzle
  generated the CHECKs, the backfill UPDATE is appended). Lands after 0234, alone.

## What changed

- **DB:** `memory_project_suggestions.state` CHECK gains `stale` (no decider, no reason: the
  existing `decided`/`reason` CHECKs already allow exactly that). `notifications` kind CHECK (and
  the `notifications_actor`/`notifications_memory` CHECKs derived from the kind lists) gain
  `memory.suggestion.stale`. Same kind added to `MEMORY_NOTIFICATION_KINDS` in @kobe/protocol (the
  server contract test keeps the two lists equal). No SECURITY DEFINER, no new table; FORCE RLS
  lifted only around the backfill UPDATE (owner role, as 0201/0202) and restored in the same
  transaction.
- **Backfill (existing rows):** before this both paths wrote `expired` + `decided_at = now()` +
  no decider, and no audit event records either. The 30-day sweep only touches rows with
  `expires_at <= now()`, so a row with `decided_at < expires_at` can only have been staled: those
  become `stale`. A row staled after its `expires_at` but before the nightly sweep reached it is
  indistinguishable and stays `expired`. Notifications already sent keep their old kind.
- **Server:** `staleMovedSuggestions` (thread move in `threads/organize.ts` and the click-time check
  in `decide.ts`) writes `stale` and notifies `memory.suggestion.stale`. The KOBE-651 sweep is
  unchanged (`expired`, only `pending` rows). KOBE-671's purge conditions are all
  `state <> 'pending'` (pass purge, pass-less purge by decision date, offboarding deletes every
  state), so `stale` is purged like `expired` with no code change (tested). Decide refusals now
  say why: stale → "This conversation left the project, so its suggestion no longer applies";
  expired → "suggestions wait 30 days"; else "already decided". Queue health (KOBE-411) counts
  only approved/dismissed as decisions: unchanged, stale is not a decision either.
- **Audit:** no per-suggestion audit for expiry or staling existed; `retention.memory_learning_purged`
  counts only the sweep (`suggestionsExpired`). Nothing to widen.
- **Web:** state labels: Waiting / Added to notes / Dismissed / **Expired after 30 days** /
  **Conversation left the project** (reader's Your suggestions; the deciders' queue and To review
  list only pending ones). Bell: `memory.suggestion.expired` → "Your project note suggestion
  expired undecided after 30 days"; new `memory.suggestion.stale` → "Your project note suggestion
  closed: its conversation left the project" (same deep link), digest plural added.
- **Guide:** `docs/guide/memory.md` Suggest to editors: table of the five labels and the backfill
  note; notifications section and retention paragraph mention the stale case.

## memory_candidates `expired` (checked, not changed)

`memory_candidates.state = 'expired'` is written only by the 14-day sweep
(`retention/memory-learning.ts`); no other code path (thread move included) sets it, so there is
no ambiguity. `memory_proposals.expired` is likewise only the 30-day sweep, plus `repropose` marking a
pending one already past `expires_at` (same meaning).

## Tests (written first)

- `packages/db/src/memory-suggestion-stale-upgrade.db.test.ts` (new): populated DB at 0234 →
  migrate; early-decided `expired` → `stale`, swept and late-moved stay `expired`, pending/approved
  untouched; new CHECK values; FORCE RLS on.
- `memory-project-suggestions.db.test.ts`: `stale` needs `decided_at`, refuses a decider and a
  reason. `memory-notifications-upgrade.db.test.ts`: kind list.
- `services/server/src/memory-suggestions.db.test.ts`: thread move → `stale` +
  `memory.suggestion.stale`, reader's list shows `stale`; click on a moved one → `stale`.
- `memory-learning-retention.db.test.ts`: sweep → `expired` and leaves a `stale` row (no notice);
  purge removes stale with its pass and by decision date, keeps a recent one (counts 2 → 4).
- Web: `lib/notifications/memory.test.ts` (both titles, link), `suggestions-review.test.tsx`
  (both labels in the reader's view).
- Ran: db suite files above + probe, catalog, migrate, journal; server suggestions + retention db
  files; `pnpm verify`.

## Docs

Guide updated in this change (member-visible labels and notification wording).
