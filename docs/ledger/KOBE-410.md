# KOBE-410: SMD3: Learn nudge

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed locally (no push, no PR, per the brief)
- **Branch / worktree:** `kobe-410-sm` in `../Kobe-wt410`
- **Depends on:** KOBE-408 (done), Phase B (KOBE-395 + / Learn state, KOBE-661 learn watch)

## Plan

The Learn state (`GET /v1/threads/{id}/learn`, `services/server/src/memory/learn/state.ts`) gains
`nudge: {reason, key} | null`; the + button (`apps/web/components/chat/plus-learn.tsx`) pulses its
existing dot once per `key`. A Site switch `memory.learn_nudge_enabled` turns it off. No
migration, no pass ever started by the nudge.

## Decisions

- **Correction signal (deterministic, no text regex):** a thumbs down (KOBE-275 `answer_feedback`,
  `rating = 'down'`) by the person in the thread with `updated_at` after their watermark
  (`memory_learning_watermarks.updated_at`, i.e. their last pass), **or** an edited message: a user
  message on the branch after the watermark that has an earlier sibling user message (same parent)
  with different `content`. Why: both are explicit, already-recorded acts of the person; a regex on
  "no, I meant…" is language-bound and noisy. Regenerate and Retry re-send the same prompt text
  (same parent, same content), so they are not corrections (they ask for another answer, not a
  different one); excluded by the content comparison.
  Caveat: "Continue from here" on an earlier answer with a new message is structurally the same as
  an edit (a sibling user message with other text), so it also counts as a correction; accepted
  (taking the conversation another way is a fair moment to offer Learn).
- **Threshold = 10 user messages** (`LEARN_NUDGE_MESSAGES` in `@kobe/protocol`), counted on the
  visible branch after the watermark's common ancestor (the range `/learn` reads), or after the
  fork point, or from the start when there was no pass.
- **Phase B data (ac-2), gate1 `kobe` DB, 2026-11-18, read-only counts:** 36 passes, all completed,
  17 candidates in all. User messages per pass (seq range from..to): 1 msg in 31 passes, 3 in 3,
  6 in 1, 20 in 1 (median 1, mean 1.8). No `answer_feedback` rows at all (thumbs down never used).
  These are acceptance-test passes started by hand on short chats, so they say nothing about when
  people forget to learn; too small to tune. Kept the spec's ~10 (SM17/Q8). Revisit with real use
  (count of passes started within a few messages after a nudge vs without).
- **Once per crossing:** `key = "<watermark entry id | start>:<reason>"`, so at most one messages
  pulse and one correction pulse between two passes. The web remembers the last key per thread in
  `localStorage` (`kobe.learn-nudge.v1:<threadId>`; only the owner reads a thread's Learn state, so
  thread = person), in memory when storage is blocked (`apps/web/lib/chat/learn-nudge.ts`). Two
  beats (2.4 s), `prefers-reduced-motion: reduce` → no animation (the still dot).
- **Gates:** the server sends a nudge only while the dot would show: Learn could start (no
  blocker), no running pass, no candidates waiting, new messages, and the effective `learnNudge`
  (`learn` AND the Site switch). The SQL read runs only then.
- **Switch:** Site only (`learnNudgeEnabled`, key `memory.learn_nudge_enabled`, wire
  `learn_nudge_enabled`), default on, written and audited with the other Site switches
  (`memory.site_settings_changed.learnNudgeEnabled`, optional for older rows). The Site console
  shows **Nudge to learn** under Learn from this chat (needs memory, memories, Learn).
- **Protocol:** `learnStateSchema.nudge` is **optional** and nullable (additive; an older server
  omits it). Small enough to stay in this PR; flagged below.

## Open questions (for Chris or the coordinator)

- The protocol field is added inside this feature PR (additive, optional). parallel-work.md asks
  for contract changes in their own PR: split it if you prefer.
- Should a Workspace switch exist too? The brief says Site switch only; not added.

## Evidence (acceptance criteria → test or command output)

- **ac-1** pulse on threshold, never auto-runs: `services/server/src/memory-learn-nudge.db.test.ts`
  (threshold 9 vs 10, watermark key, other branch, thumbs down before/after a pass, edit vs
  regenerate, no pass row created, blocked → no nudge); `apps/web/components/chat/plus-learn.test.tsx`
  ("the nudge pulses the dot once per crossing…", "no nudge, no pulse"); `apps/web/lib/chat/learn-nudge.test.ts`.
- **ac-2** threshold documented: this ledger (gate1 counts above) and `LEARN_NUDGE_MESSAGES`.
- **ac-3** switch: db test "the Site switch turns it off (audited) and back on";
  `services/server/src/memory/switches.test.ts` (effective matrix row `learnNudgeEnabled`);
  `apps/web/components/admin/memory-switches.test.tsx` ("turns the Learn nudge off on its own").
- **ac-4** docs: `docs/guide/memory.md` (The nudge, switch list, summary), `docs/guide/admin/site-admin.md`,
  `docs/install.md` (new site_settings key). /llms.txt and /llms-full.txt are built from the guide.
  "For agents" pages: no change (the in-sandbox agent neither sees nor triggers the nudge).
