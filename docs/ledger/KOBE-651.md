# KOBE-651: SMB13: Phase B retention sweeps — candidates, passes, proposals, suggestions

- **Status:** in review (local commits on `kobe-651-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-651-sm` in `../Kobe-wt651`, based on `kobe-397-sm`, with
  `origin/main` merged in (c9c838dd: KOBE-395, the 652 migration 0231/0232). Rebase onto main
  once 396/397 merge.
- **Depends on:** KOBE-389, KOBE-397, KOBE-386, KOBE-645. **Migration:** none.

## Plan

- `services/server/src/retention/memory-learning.ts`: `sweepMemoryLearning` (team pass step
  `memory_learning`, after `semantic_memory`) and `purgeDepartedLearningInTx` (offboarding step 4b).
- `services/server/src/memory/learning-export.ts`: `memory-learning.json` in the personal export.
- Audit `retention.memory_learning_purged` (packages/db `AUDIT_EVENTS`, `docs/audit-log.md`).

## Decisions

- **One runner:** the nightly retention job (session advisory lock `kobe.retention`); each batch
  (200 rows) is its own `withTeam` transaction: `lock_timeout 5s`, `lockLegalHolds` first, `SKIP
LOCKED`. Expiry is daily-granular; lists and actions already treat `expires_at <= now()` as gone
  (KOBE-396/397), so the state change is for records, notices and the pass purge.
- **Holds:** `legal_hold_covers(team, person)` (a hold on the person or on the Workspace), the
  same rule the 0229/0232 delete guards apply; owner = pass person (passes, candidates), proposer,
  suggester. Held people's rows are skipped by every sweep, expiries included (nothing of theirs
  changes while held; it expires and notifies after release). A **Site-wide hold** covers Site
  memory tables only (KOBE-647 scope), so it does not stop these sweeps (tested). Flag if the
  coordinator meant otherwise.
- **Candidates:** `open` past `expires_at` → `expired` + `decided_at`; no dismissal row. The pass's
  To review reminder is settled once none of its candidates is open. No notice (no kind for it).
- **Proposals / suggestions:** `pending` past `expires_at` → `expired` + `decided_at`
  (`decided_by` null, as the CHECK wants); reminders settled; proposer/reader told with
  `memory.proposal.expired` / `memory.suggestion.expired` (with `project_id`) through
  `notifyMemoryAll`, last in the same transaction as the state change, so once.
- **Passes:** completed/failed passes with `finished_at` older than the Workspace window go with
  their candidates (cascade; the 0229/0232 refs on proposals/suggestions become NULL). Skipped while
  a candidate is `open` or shown by a pending proposal/suggestion (397's queue joins evidence from
  the candidate). Nothing while the Workspace keeps forever. `run_usage` (`memory_learn`) is the
  billing ledger and is not touched.
- **Thread purge:** already cascades (0228/0231 FKs); covered by a server-level test through the
  nightly Trash purge (proposal kept with `candidate_ref` NULL).
- **Erasure (offboarding / deactivation, 30 days after leaving):** passes (+ candidates),
  dismissals, watermarks, proposals (every state) and suggestions the person made; reminders and
  notifications whose `memory_object_id` is one of those objects (curators' and editors' bells).
  Approved Workspace items stay ("former member"); conversations follow thread retention. Same
  gate as KOBE-386: nothing if the person is an active member again or held; always audited.
  A member with Phase B rows always had a sandbox (a pass needs a completed run), so the 30-day
  record exists.
- **Export (`memory-learning.json`):** passes (no `usage`), candidates (statement, kind,
  destination, operation, confidence, rationale, filtered evidence; no warnings, conflict or
  near-duplicate refs), dismissals (hash), watermarks, proposals (no `decided_by`; reason kept),
  suggestions (filtered evidence). Thread ids only for conversations the person owns now; quotes
  only of the person's own messages there (649's `ownThreads`/`ownMessages`/`quoteFoundIn`).
  Effective state shows `expired` for past-due rows not yet swept. Paged (200) per transaction.
- **KOBE-652:** only the sweep, erasure and export of `memory_project_suggestions`; its service
  is untouched.

## Open questions (for Chris or the coordinator)

- Decided/expired proposals and suggestions are not purged by age (not in the brief); they go with
  offboarding (proposals) or their conversation (suggestions). Add a window later if wanted.
- `thread.exported` audit does not count the learning records (only `memoryItems`).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/memory-learning-retention.db.test.ts`: candidate expiry (14 d,
  reminder settle; held person, Workspace-wide hold, Site-wide hold not freezing), proposal expiry
  (held until release), suggestion expiry (held Workspace), pass purge (window, forever, kept while
  proposed/suggested, held).
- **ac-2** same file: notice once on a second pass (proposals, suggestions); no dismissal rows
  after candidate expiry.
- **ac-3** same file › thread purge.
- **ac-4** `docs/guide/memory.md` (How long memories are kept + summary), `chat/threads-panel.md`
  (export + summary), `admin/team-admin.md`; `/llms.txt` is generated from the guide;
  `docs/audit-log.md`.
- **Erasure/export (note):** same file › erasure on offboarding (erase, hold, return);
  `memory-learning-export.db.test.ts` (own rows only, quotes filtered, no curator ids, other
  person and other Workspace absent).
