# KOBE-396: SMB8: To review panel — cards, actions, batch Undo and lifetime

- **Status:** in review (commits on `kobe-396-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-396-sm` in `../Kobe-wt396` (based on `kobe-393-sm`, PR #581)
- **Depends on:** KOBE-393 (candidates), KOBE-384 (Memory panel), KOBE-645 (notification kinds)

## Plan

No migration, no protocol change (the review wire types live in the server route and
`apps/web/lib/memory/review-api.ts`).

- Server `services/server/src/memory/review/`: `rules.ts` (pure: allowed scopes, lock, save
  shape, Save all mine), `stored.ts` (payload parse, list, lock, decide, reopen), `evidence.ts`
  (person quote at click), `decide.ts` (save, dismiss, save-all, undo), `list.ts`, `notify.ts`;
  route `routes/memory-review.ts` at `/v1/memory/review`.
- Item store: `openOp` + `createItemIn` / `patchItemIn` / `archiveItemIn` / `revertItemIn`
  (the existing functions now wrap them), so a decision writes the memory and the candidate on one
  transaction through the one write path.
- Web `apps/web/components/memory/review/*`: `ReviewSection` atop the Memories tab, `CandidateCard`,
  `candidate-details`, `statement-diff`, `labels`, `arrival` (auto-open rule).

## Decisions

- **Re-check at click (one `withTeam` tx, candidate `FOR UPDATE`):** caller is the pass's person
  and still the thread's owner (else 404); open and unexpired (else 409 `memory_item_inactive`);
  scope in `allowedScopes` (inferred → user/portable only and locked; project-notes → user only
  until KOBE-398; update/supersede/conflict → the target's scope, locked; portable needs a
  preference and `confirm_portable`); `team` needs `quotesThePerson` (not inferred, every quoted
  entry a user/assistant message of the thread, at least one the person's) → 403. Then the item
  store: switches, curator rights (non-curators get 403; Propose… is KOBE-397), limits,
  `memory/checks.ts`, Policy conflict + audited override.
- **Operations:** add → create; update → `patchItemIn` on the target (new version); supersede and
  conflict → create with `supersedes_id` (saving a conflict picks the new statement).
- **Decision record:** `payload.decision = {item_id, scope, version, op, batch}` (no column, no
  migration); removed when Undo reopens the candidate.
- **Save all mine:** new personal (`add`, user/portable-preference) candidates only; all or
  nothing in one transaction; any refusal saves nothing (the error contract is strict, so the
  refused candidate is not named; the person handles it on its card).
- **Undo:** create → archive (as the editor's Undo); update → revert to `version - 1`; supersede →
  refused (the replaced item stays superseded). Expected version checked → 409 when the memory
  moved on; all or nothing. Reopened candidates re-register the reminder.
- **Dismiss:** state `dismissed` + `memory_dismissals` row with `statementHash(payload.statement)`
  (recomputed, not read from the payload).
- **Expiry:** listing and actions treat `expires_at <= now()` as gone; expiry adds no dismissal;
  the sweep that sets `expired` is KOBE-651.
- **Merge:** the pass already drops statements open for the person (KOBE-393); the list also shows
  one card per `statement_hash` (newest pass first) in case of a race.
- **Notices:** a completed pass with candidates registers one reminder (object = pass) and sends
  `memory.review.candidates_ready` last in its success transaction (`learn/execute.ts`); the
  reminder is settled when none of the pass's candidates is open. Auto-open calls
  `POST /v1/memory/review/seen` (marks the thread's candidates_ready notices read). The bell's
  candidates_ready now has **Open To review** (`/me/memory?review=1&thread=<id>`).
- **Auto-open (web):** `arrivalFor` = open when the pass's thread is on screen and no route panel is
  open; otherwise wait (bell + count). Mounted in `ChatWorkspace` via `useReviewArrival`.
- **Audit:** `memory.candidate.accepted` (`candidateId, passId, threadId, scope, itemId, version,
edited, batch`) and `memory.candidate.dismissed`; registered in `AUDIT_EVENTS`, docs/audit-log.md.
- **Evidence quotes:** `lib/chat/reveal-request.ts` event; the thread view's
  `useRevealRequests` calls `controller.reveal`, which scrolls and now flashes (reduced motion: no
  flash). Entries off the current branch are not shown.

## Seams for other tickets

- **KOBE-395** (pass UI): call `announcePassCompleted({threadId, passId, candidates})` from
  `components/memory/review/arrival.ts` on `memory.pass.completed`; the `+` count can use
  `useReviewArrival`'s `onWait` or `createReviewApi().list(threadId)`. This ticket does not touch
  the `+` menu.
- **KOBE-397 / KOBE-398 / KOBE-652:** `CandidateCard` `seams.onPropose` and
  `seams.onAddToProjectNotes` (buttons appear only when given); server `rules.ts` keeps
  project-notes candidates personal until then.

## Open questions (for Chris or the coordinator)

- The artifact side panel does not count as "another panel" for auto-open (only route panels).
- A reminder's link (`?review=<passId>`) still opens To review for the thread on screen.
- No gate1 browser spec: it needs a real learning pass (KOBE-395's Learn) to create candidates.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `components/memory/review/arrival.test.ts` (open vs wait, seen marked);
  `memory-review.db.test.ts` "tells the person in the bell, marks it read when seen, and settles
  the reminder"; `memory-learn-pass.db.test.ts` success test asserts the notice + reminder.
- **ac-2** `memory-review.db.test.ts` card actions (save, edited/portable, scope rules, Policy
  conflict + Save anyway, update + Undo, dismiss, author-only), Save all mine + batch Undo,
  refused Undo; `review-section.test.tsx` (every card action, Save all mine, Undo, diff, Policy
  block, evidence reveal); `rules.test.ts`.
- **ac-3** `memory-review.db.test.ts` "shows the author's open candidates … merged once" (two
  passes, duplicate hash, expired hidden) and "an expired candidate can't be saved or dismissed
  and is not a dismissal".
- **ac-4** `docs/guide/memory.md` new "To review" section, summary and notifications text (served
  at /docs and /llms.txt).
