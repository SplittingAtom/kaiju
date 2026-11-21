# KOBE-770: memory-learn-pass.db.test 'two replicas starting at once' let both passes through — product or test?

- **Status:** in review (group 58, branch `group-58-flaky-tests` in `../Kobe-g58`)
- **Depends on:** none

## Verdict: a product race (and a test that could not see it)

**What the database already enforces (ac-1).** One queued or running pass per thread is the
partial unique index `memory_learning_passes_active_unique` on `(team_id, thread_id) WHERE status
IN ('queued','running')` (migration `0228_memory_learning.sql`). The start
(`services/server/src/memory/learn/run.ts` `prepare`) runs in one `withTeam()` transaction: it takes
the thread's change lock (`lockForChange`, `FOR NO KEY UPDATE` in `assembleLearningInput`), reads the
person's watermark, runs the checks, then claims with `INSERT … ON CONFLICT DO NOTHING RETURNING id`
(`insertRunningPass`); no row back means `pass_running`. Two starts serialize on the thread lock,
and two inserts on the index, so two _running_ passes can never coexist. That part held.

**The hole.** The pass's completion transaction (`execute.ts` `finish`: candidates, completed
event, pass row → `completed`, watermark) did not take the thread lock. So this interleaving was
possible, and is what CI run 44879655124 hit (two `ok: true` results):

1. Replica A's start commits its `running` row; the pass runs in the background (the fake gateway
   answers at once).
2. Replica B's start gets the thread lock and reads the **old** watermark (A has not finished).
3. A's completion commits: the row leaves `running`, the watermark moves.
4. B's claim no longer meets an active row: it inserts and returns `ok`.

B then learns the same messages A just learned: a second model call (double spend) and the same
candidates offered twice. Not a test artefact: in production a pass is seconds long, but a start on
another replica (double click, two tabs) landing in A's last milliseconds does exactly this. A
purely sequential second start is refused `nothing_to_learn`, so "both ok" can only come from this
race.

Recent main changes checked: the KOBE-732 per-connection timeouts and pool connect hook change
neither the isolation level nor the claim; `BackgroundTasks` only schedules the pass. They can shift
timing (which made the window easier to hit) but not the semantics.

## Fix (ac-2)

`finish` now takes the thread's row lock (`lockThreadRow`, the same `FOR NO KEY UPDATE` a start
holds) as its first statement, before it touches the pass row. Lock order stays thread → run
(KOBE-29). Taken first, so no deadlock: a start waiting for the lock holds nothing the completion
needs, and a completion waiting for the lock has not yet updated the pass row a start's claim could
wait on. Outcomes are now: B before A's completion → B's claim meets A's running row →
`pass_running`; A's completion first → B reads the moved watermark → `nothing_to_learn`.
`fail()` does not need the lock: a failed pass leaves the watermark, so a second start after it is
correct. No migration.

Test seam: `LearningPassesOptions.beforeClaim(tx)` runs in the start's transaction just before the
claim (like the existing `timeoutMs` seam).

## Tests (`services/server/src/memory-learn-pass.db.test.ts`)

- **New, forces the interleaving:** "a pass that finishes while another replica's start is checking
  cannot let it learn the same messages". A's model call is held by a latch; B's `beforeClaim`
  releases it, then waits (`vi.waitFor`, a condition) until A's row has left `running` **or** a
  backend is blocked by B's (`pg_blocking_pids`). Then B claims. Before the fix this failed
  deterministically (`expected { ok: true … } to match { ok: false, code: 'pass_running' }`);
  after it B is `pass_running`, A completes, one pass row, one model call.
- **Reworked (ac-4, not weakened):** "two replicas starting at once" now holds the winner's model
  call open with a latch, so the overlap is real; still exactly one `ok` and one `pass_running`,
  and one gateway call.
- **New, sequential:** "a start after the pass finished has nothing new to learn".
- `FakeGateway` awaits a reply function (needed for the latch).

## Docs

No `docs/guide` change: nothing a member, admin or agent sees changes (a second start in the race
window is now refused like any other overlapping start).

## Evidence

- RED before the fix: the new test failed as above (1 failed, 4 passed in the describe).
- Whole file after the fix: 21/21.
- 30 consecutive single-file runs: 30 passed, 0 failed; once more beside
  `packages/db` `budget-reservations.db.test.ts`: 21/21.
- `src/memory*` db tests (31 files, 360 tests) green; server typecheck and lint clean.

## Review follow-ups (PR #648 review, two LOWs)

1. **Completion behind a busy thread.** `finish` waited for the thread lock with the 5 s
   append lock timeout; a longer holder failed the pass as `model_error` after the model call was
   paid for. The completion transaction now runs again on a lock timeout (55P03; it rolled back
   whole, so a rerun is safe) after 1 s and 3 s (3 tries, at most ~19 s, inside the pass's 30 s
   event margin), reusing the model answer; then the pass fails with the new code `thread_busy`
   (`thread_busy: lock_timeout` on the row, retryable, its own message). New code added to
   `MEMORY_PASS_FAILURE_CODES` (protocol), `MEMORY_PASS_AUDIT_FAILURE_CODES` (db audit vocab) and
   `docs/audit-log.md`. Tests (`memory-learn-pass.db.test.ts`, "completion behind a busy thread"):
   the thread locked by another connection after the start; freed before the first retry → the
   pass completes with one model call; never freed → `thread_busy` event, row and audit, watermark
   kept. Both failed against the previous `execute.ts` (no retry).
2. **Start behind a busy thread.** A start that waited past `THREAD_LOCK_TIMEOUT` (2 s) threw 55P03
   and the route answered 500 (confirmed by running the new test without the mapping). It is now
   the refusal `thread_busy` (409, "The chat is busy right now. Try again in a moment."), the same
   code and status the other thread-lock routes answer; mapped in `LearningPasses.start`, so
   `/learn` and every other caller get it. Test in `memory-learn-route.db.test.ts` holds the
   thread's row lock from another connection: 409 `thread_busy`, no pass row.

Docs: `docs/guide/memory.md` (Learn from this chat) now says Kobe answers "busy" when something
else is changing the conversation, at the start or while saving, and you try again.
