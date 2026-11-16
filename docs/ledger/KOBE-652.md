# KOBE-652: SMB14: Readers' 'Suggest to editors' for project notes

- **Status:** in review (feature commit on `kobe-652-feature`; coordinator opens the PR)
- **Branch / worktree:** `kobe-652-feature` in `../Kobe-wt652`, on `kobe-398-sm` (398 not merged;
  396 is PR #585) with origin/main merged in for the migration (PR #584, 0231/0232)
- **Depends on:** KOBE-398 (signed Notes approval), KOBE-645 (notification kinds, reminders),
  KOBE-389. Expiry sweep is KOBE-651 (not here). No new migration, no protocol change.

## Plan

- Server `services/server/src/memory/suggestions/`: `rows.ts` (read/lock, deciders, staling),
  `suggest.ts` (reader suggests from a candidate), `decide.ts` (preview/approve/dismiss),
  `list.ts`. Routes: `POST /v1/memory/review/candidates/:id/suggest`; `routes/memory-suggestions.ts`
  at `/v1/memory/suggestions` (`GET ?project_id=`, `POST /:id/preview|approve|dismiss`).
- Web: `lib/memory/suggestions-api.ts`; `review/suggest-action.tsx` replaces 398's disabled stub;
  `memory/suggestions/` (card + `SuggestionsReview`) on the project page's new **Memory** tab and
  under To review on My memory.

## Decisions

- **Suggest (reader only):** candidate locked as in 398 (`lockCandidate`: own, open, unexpired);
  thread's project read now; caller must be a reader (editors get 403 "add it yourself"); project
  memory switch on; statement whitespace-collapsed and scanned with 398's shared-text rules
  (`scanSharedLine`, extracted from `planChange`: secret 422, instruction lint 409). Kind may be
  changed on the card. Evidence keeps only quotes whose entry is a `user` message of the thread
  (the thread owner's), capped at 20 / 16 KiB; none left → 403 `memory_not_allowed`. Candidate →
  state `suggested` with `decision {op: "suggested", suggestion_id, project_id}` (Undo refuses).
- **Status on the card:** readers now get `project_notes.available = true` (reason only when
  project memory is off); Add stays refused for readers (403, reason text names Suggest).
- **Deciders:** project `owner`/`editor` rows + Team admins (same rule as 645's reminder re-check),
  minus the suggester. They get `memory.suggestion.received` (actor = suggester) and one reminder
  (`registerMemoryReminder`, about `memory.suggestion.received`, with project).
- **Approve:** 398's path (`planChange`) with the signed approval, tool
  `kobe.project_notes.suggestion`, `run_id` = `tool_call_id` = suggestion id (so a candidate's
  token never covers a suggestion; unit test). Role re-checked at click (`projectMemoryAccess`
  write, then `planChange` again). Approver may edit the statement (API only; UI sends none).
  Written as the approver (`writeMemory`, `actorKind: user`). Single use = the row (`FOR UPDATE`,
  `pending`).
- **Dismiss:** optional reason (1..1000 chars, the table's CHECK), shown to the suggester in
  **Your suggestions**; never in audit (`reasonGiven` flag only).
- **Staling (PE5):** `moveThread` calls `staleMovedSuggestions` last (pending rows whose thread's
  project differs → `expired`, reminders settled, suggester told `memory.suggestion.expired`).
  Any other path (direct update) is caught at the next click: the row expires (committed) and the
  click gets 409. Lists never show a moved one (join on the thread's current project).
- **Audit:** `memory.suggestion.created|approved|dismissed` (ids and flags; never text).
- **Lists:** `GET ?project_id=` → `can_decide`, open suggestions (deciders only), the caller's own
  (`mine`, all states, 50); without → open suggestions across the caller's projects (To review).
- **Deep link:** 645's `/me/projects/<id>?suggestion=<id>` opens the new Memory tab and focuses the
  card.

## Open questions (for Chris or the coordinator)

- Expired-by-sweep (KOBE-651) and staled rows both use state `expired` and the same notice kind.
- Readers see the evidence editors will see only as the rule ("quotes from your own messages"),
  not the filtered list, before confirming.

## Evidence (acceptance criteria → test or command output)

- **ac-1** migration landed alone in PR #584 (earlier commit; probe suite there).
- **ac-2** `services/server/src/memory-suggestions.db.test.ts` "from their candidate card…",
  "refuses without the reader's own words…", "show in project Memory → Suggestions and To review;
  Approve appends…" (reader can't approve/dismiss), "a Team admin dismisses with a reason…",
  "re-checks the role at click"; `notes-approval.test.ts` (suggestion token separation); web
  `project-notes-action.test.tsx` "Suggest to editors", `suggestions-review.test.tsx`.
- **ac-3** same DB file: suggester notified on approve/dismiss/stale; "reminds the deciders after
  7 days…"; "a move expires the thread's pending suggestions…", "a click on a suggestion whose
  thread moved…".
- **ac-4** `docs/guide/memory.md` "Suggest to editors", "Readers' suggestions", notifications
  bullet; `docs/guide/files/workspaces-and-projects.md` Memory tab (served at /docs, /llms.txt);
  `docs/audit-log.md` rows.
