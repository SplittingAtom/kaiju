# KOBE-392: SMB4 — learning pass input (leaf path, entry watermark, fork/copy lower bound, compaction fallback, related items)

- **Status:** in review (commits on `kobe-392-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-392-sm` in `../Kobe-wt392`
- **Depends on:** KOBE-389 (tables), KOBE-390 (contract), KOBE-394 (prompt input), KOBE-399

## Plan

Server-only, no migration, no protocol change. `services/server/src/memory/learn/pass-input/`:

- `assemble.ts`: `assembleLearningInput(tx, viewer, threadId, options)` → `{ ok, input }` or a
  refusal. KOBE-393 calls it inside its `withTeam()` transaction and hands `input.prompt` to
  `extractorMessages`. Reads only: no pass row, no watermark move.
- `range.ts` (pure): lower bound + watermark → first entry read.
- `transcript.ts` (pure): one entry → transcript piece or skip reason.
- `budget.ts` (pure): ~60k-token / 256 KiB cap with the compaction fallback.
- `collect.ts`: reads bodies newest first in chunks of 200 and stops past the cap.
- `read.ts`: branch, watermark ancestry, fork entry seq, bodies (all with explicit `team_id`).
- `related.ts`: every Policy item + top 40 of user/portable/team by the A7 relevance score.

## Decisions

- **Author:** `lockForChange` (owner only; readers `read_only`, others `thread_not_found`).
  Also refused: Trash, builder test / Workbench / eval threads (`test_thread`, as labels Q23),
  and a transaction with a break-glass grant set (`break_glass`). A scheduled thread's owner
  passes like any owner.
- **Visible branch:** root → `threads.leaf_entry_id`. Optional `viewedLeafEntryId`; a different
  head answers `not_current_branch` with the current leaf (panel offers Make it current).
- **Watermark:** on the branch → continue after it (`continue`); elsewhere → after the LCA
  (`lca`; no common entry → whole branch); `rescan` ignores it. Watermark = leaf →
  `nothing_to_learn`.
- **Fork / shared copy (Q9):** copied = `created_at <= thread.created_at` OR
  `seq <= seq(forked_at_entry_id)` (the export's H-1 rule, so a missing fork entry still holds).
  Copied entries are a prefix of every branch of the fork; rescan and LCA never go below it. A
  copy of a shared thread is a fork (same route, same columns), so the same rule covers it.
- **Committed only:** rows in `thread_entries` (streaming entries have none yet).
- **Transcript:** `user` → person (server lines stripped via `memberText`, images `[image]`),
  `assistant` → text + `[tool call] name {args…}` one-liners (no reasoning), `toolResult` →
  skipped unless opted in, then ≤2 KB (UTF-8, char boundary), backtick fence longer than any run
  inside, labelled untrusted. `compaction` → summary (only in over-cap mode). `branch_summary`,
  offloaded bodies, custom messages, model changes: skipped and counted in `skipped`. Entries cut
  at 24k chars.
- **Over cap:** newest compaction of the range + newest turns that fit beside it; no compaction →
  newest turns only. Flags `truncated` / `summarised` for the panel; `estimatedTokens`
  (chars/4 + header overheads, items included) for the tooltip.
- **Entry ids:** Pi ids are short hex, not uuids, so `prompt/input.ts` now takes
  `[A-Za-z0-9_-]{1,128}` (`isSafeEntryId`) instead of a uuid; the forged-header test still holds.
  The pass input skips entries with any other id (`unsafe_id`).
- **Related items:** Policy (all, while `memory.policy`) first by id, then `readRecallRows` over the
  enabled user/portable/team lanes ranked by `relevanceScore`, top 40. Non-Policy Site items are
  not listed (a pass never targets the Site). New `readPolicyItems` in `items/run-memory.ts`.
- **Project:** `{ id, name, role: editor | reader }` from `loadAccess` (`can.edit`), for
  KOBE-398 / KOBE-652; the prompt gets the name only.
- **Docs:** none: no user-facing surface yet (KOBE-395/396 add the panel and its guide text).

## Open questions (for Chris or the coordinator)

- A compaction summary written in a fork after the fork point may summarise copied turns. It is
  a `summary` speaker (never evidence), so kept; say if it should be dropped in forks.
- Workbench test chats are refused like builder tests and evals (labels precedent); the spec
  names only evals, eval cases and agent-creator test chats.
- Offloaded bodies (>64 KB) are skipped, not read from S3; KOBE-393 may want them.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `src/memory-learn-input.db.test.ts` "visible branch and watermark", "branch summaries",
  "fork and shared-copy lower bound"; pure cases in `pass-input/range.test.ts`.
- **ac-2** db test "over the cap"; `pass-input/budget.test.ts`.
- **ac-3** db test "related items and tool output"; `pass-input/transcript.test.ts`.
- **ac-4** db test "author only" (shared reader, private non-owner, break-glass, Trash, test).
