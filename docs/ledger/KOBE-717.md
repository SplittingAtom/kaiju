# KOBE-717: Split fake-kobe.ts per API area, bind it to @kobe/protocol (review CODE-11)

- **Status:** in review (group 54, local commits)
- **Branch / worktree:** `group-54-web-chat` in `../Kobe-g54`
- **Depends on:** KOBE-716 (same branch, both touch `lib/chat/`)

## Plan

1. Pure move (own commit): `lib/chat/testing/fake/` — `state.ts` (wire records, helpers),
   `store.ts` (`FakeStore`: every field tests read or set), `core.ts` (`FakeCore extends
FakeStore`: threads, entries, runs, queue, snapshots, summaries), one handler per area
   (`account`, `artifacts`, `workspace`, `memory`, `projects`, `threads`, `thread-actions`,
   `thread-tree`, `thread-settings`, `apps`, `runs`, `approvals`, `egress`). `FakeKobe extends
FakeCore` keeps setup, the scripted agent, `fetch` (two handler tables: open areas, then the
   team-scoped ones after the `X-Kobe-Team` check, in the old order) and the event streams;
   `FakeEventSource` stays. Public surface and import path unchanged (113 importing files).
2. Contract tests (`fake/<area>.contract.test.ts`, helper `fake/contract.ts`): each asks the fake
   over `fetch` as the web does and parses the answer with the route's protocol schema; each has a
   deliberate-drift case that the schema must refuse. Run events are parsed with
   `kobeEventSchema`. Compile-time binding where it holds without casts: `ProjectCommit`,
   `ProjectFile`, `LaunchAppCardResponse`, `CompactThreadResponse`, `BranchSummaryResponse`,
   `ThreadLineageResponse`.

## Drifts found (the fake was wrong; web tests were testing against a wrong server)

1. **App cards' `result_ref`** was `card-ref-N`; the server's is a uuid
   (`launchAppCardResponseSchema`, `appCardDetailsSchema`). Now `uuid(12, N)`.
2. **App card entry `details.opened_by`** was `"u-1"`; the server stores the opener's uuid.
3. **`GET /v1/projects/{id}/commits`** listed commits with only `id/project_id/seq`; the
   protocol's `projectCommitSchema` also has `parent_id`, `author_user_id`, `author_kind`,
   `thread_id`, `run_id`, `message`, `file_count`, `bytes`, `created_at`. Now complete.
4. **`GET /v1/threads/{id}/file-links`** (one thread, KOBE-611) was not served at all (404); the
   web calls it (`threadFileList`). Now answered from the same links, 404 for unreadable threads.

No component test depended on the wrong shapes (full suite unchanged after the fixes), so no
`it.fails` contract test was needed.

## Not contract-checked (no protocol schema; server-side types only)

Thread summary/detail and lists, run snapshot (status checked with `runStatusSchema`), pending
messages, entry pages, `/v1/me`, `/v1/me/teams`, team models, runnable agents, approval views and
remember offers (scope values checked), egress requests, usage, markers, app results, budgets,
retention. Worth protocol schemas in their own ticket; until then these stay hand-written.

## Decisions

- Private `#` members the areas need became members of `FakeCore` (`thread()`, `summary()`,
  `snapshot()`, `queued()`, `runsOf()`, `pendingOf()`, `counters`, `sources`, `queuedCards`, …):
  additive to `FakeKobe`'s surface, nothing removed or renamed for tests.
- `rememberOptions` lives on `FakeCore` (the approvals area reads it).
- **Guide:** no user-facing change (test harness only): no docs/guide update.

## Evidence

- ac-1: `fake-kobe.ts` 2925 → 477 lines; largest new file `core.ts` 455.
- ac-2: 10 contract test files, 24 tests, each with a drift case.
- ac-3: web tests before this ticket 428 files / 3840 tests; after the split 428 / 3840 (same);
  after the contract tests 438 / 3864 (only the 10 new files and 24 tests added).
- `pnpm verify` green before the last KOBE-717 commit.
