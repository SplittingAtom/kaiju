# KOBE-398: SMB10: Add to project notes (editors, owners, Team admins)

- **Status:** in review (commits on `kobe-398-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-398-sm` in `../Kobe-wt398` (based on `kobe-396-sm`, PR #585)
- **Depends on:** KOBE-396 (To review). No migration, no protocol change.

## Plan

- Server `services/server/src/memory/review/`: `learned.ts` (pure: the `- …` line, where it goes
  under `## Learned`, the index line cap), `notes-approval.ts` (sign/verify the Notes change),
  `notes-target.ts` (thread's project now, role, switches, `MEMORY.md` read, every click check),
  `project-notes.ts` (status, preview, add). Routes in `routes/memory-review.ts`:
  `POST /candidates/:id/project-notes/preview` and `POST /candidates/:id/project-notes`; the list
  gains `project_notes` (`{project_id, access, available, reason}` or null).
- Web: `lib/memory/project-notes-api.ts` (own client, so 396's `ReviewApi` and 397's changes stay
  untouched) and `components/memory/review/project-notes-action.tsx`; `CardSeams.projectNotes`
  (render slot, replaces the unused `onAddToProjectNotes`) filled by `ReviewSection`.

## Decisions

- **The signed approval outside a run.** The run-bound approval (`remember`: approvals row,
  run_id + tool_call_id, active run) can't apply to a click in To review. Instead the server signs
  the exact change in the existing approval token format with the site approval key
  (`signApproval`/`verifyApproval`): binding run_id = pass, tool_call_id = candidate, tool =
  `kobe.project_notes.add`; signed input = person, project, `MEMORY.md`, base version, line.
  **Domain separated**: a key derived as HMAC(approval key, `kobe.project_notes.v1`) with its own
  kid, so a Notes token never verifies as a tool approval (test). Single use = the candidate row
  (`FOR UPDATE`, must be `open`). The browser holds it as an opaque base64url string. No approval
  key configured → the action is disabled with a reason (as `remember` is denied).
- **Re-checked at click** (one `withTeam` tx, preview and add alike): candidate is the caller's,
  open, unexpired (`lockCandidate`); the thread's project read now (moved out → 409
  `memory_item_inactive`, PE5); role `edit` (`projectMemoryAccess`; readers 403
  `memory_not_allowed`); project memory switch (403 `memory_disabled`); secret scan of the
  statement (422); `MEMORY.md` with the line ≤ 200 lines (409 `memory_scope_full`); base version
  unchanged since the preview (409 `memory_version_conflict`); approval covers exactly this
  change (else 403; expired → 409). Written with `writeMemory` as the person (`actorKind: user`,
  expected version), so Notes history and Undo there work as for a panel edit.
- **Which candidates:** any candidate in a project thread (ticket: "or any candidate, by choice"),
  with the card's edited statement; the statement becomes one line (whitespace collapsed).
- **Decision record:** candidate `saved` with `payload.decision = {op: "project_notes",
project_id, memory_doc_id, version, batch: false}` (decision schema is now a union); Undo in
  To review refuses it ("change it in the project's Notes"). Audit:
  `memory.candidate.added_to_project` (ids, version, `edited`) + `memory.written` (scope project).
- **Never a Workspace item; never from runs:** the route writes Notes only; the review routes
  refuse Kobe admin tool (agent) calls (`refuseAgentWrites`) and runs have no path to them.
- **Readers:** a disabled **Suggest to editors** with the reason "…coming soon"; KOBE-652 replaces
  that branch of `ProjectNotesAction`.

## Open questions (for Chris or the coordinator)

- The approval design above (derived-key token, no approvals row) is my call: the ticket's
  "existing signed project-memory approval" is run-bound. Worth a security look.
- KOBE-395 follow-up: **done** after merging origin/main (395, #582): `use-learn.ts` calls
  `announcePassCompleted` when a watched pass ends without failure (test in `plus-learn.test.tsx`).

## Security review follow-up (2026-11-16)

- **M1:** the line is scanned with the Workspace item rules (`scanMemoryText({scope: "team"})`):
  instruction-lint hits refuse with `memory_lint_warning` (409, warnings in details); other
  warnings (personal data) come back as the preview's `warnings` and show in the approval dialog.
  DB test "scans the line as shared text…", web test "shows the preview's warnings…".
- **L1:** `learnedLine` escapes a leading `<` and every backtick (`learned.test.ts`).
- **L2:** `lineCount` (store and protocol) ignores one trailing newline, so the cap is the full 200
  lines for the index everywhere, not only in `fitsIndex` (`learned.test.ts`).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `memory-review-project-notes.db.test.ts` "an editor adds under ## Learned through the
  signed approval…", "appends to an existing section; a Team admin may add too", "adds an edited
  statement only with an approval of that statement", "refuses when the notes changed…, and a
  forged approval"; `notes-approval.test.ts`; `learned.test.ts`; web
  `project-notes-action.test.tsx` (preview → approve → add).
- **ac-2** DB: "a reader sees why and is refused; the role is re-checked at click", "is disabled
  while project memory is off and when MEMORY.md is full", "a thread moved out of the project
  stales the action"; web: disabled with reason, readers see Suggest to editors.
- **ac-3** DB: no `semantic_memory_items` row added; route behind `refuseAgentWrites`.
- **ac-4** `docs/guide/memory.md` "Add to project notes" + summary (served at /docs and
  /llms.txt); `docs/audit-log.md` row.
