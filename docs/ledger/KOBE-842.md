# KOBE-842: Context panel: conversation stats and telemetry section

- **Status:** in review (committed on the branch; coordinator pushes and opens the PR)
- **Branch / worktree:** `group-144-context-stats` in `../Kobe-g144`
- **Depends on:** KOBE-841 (Context panel), KOBE-470/471 (context viewer)

## Plan

One read route, one protocol contract, one panel section; no schema, no migration, no new
tracking.

- `packages/protocol/src/thread-stats.ts`: `threadStatsSchema` (new contract, additive; nothing
  existing changes), `THREAD_STATS_RATE_LIMIT`.
- `services/server/src/threads/stats.ts`: `readThreadStats(tx, team, thread)`, 11 aggregate
  statements in the caller's `withTeam()` transaction; `routes/thread-stats.ts` mounts
  `GET /v1/threads/{id}/stats`; OpenAPI next to the context routes (`openapi/context.ts`).
- Web: `lib/chat/context-stats.ts` (read + rows), `components/shell/context-stats.tsx`, wired into
  `ContextViewer` under the gauge's legend (`.side` column); fake route + contract test.

## Decisions

- **Visibility = the thread's readers**, the rule of `GET /v1/threads/{id}/usage`: `findThread`
  (owner, project or team share) inside `withTeam()`, else 404. Cost is included because the usage
  route already gives it to the same readers (answers' footers, `/session`); every figure is a
  count or a name readers already see (run outcomes, tool cards, approval cards, footers), never
  content. The panel itself stays owner-only (CV2); a shared reader can reach the figures only
  through the API. `team.chat` permission as for every thread read.
- **Sources** (all branches of the thread):
  - turns, outcomes, retries, thinking levels, duration: `runs` (`kind = 'message'`;
    compaction, branch-summary and notebook runs are not turns); `runs_thread_idx`.
  - skills: `runs.skills_used` (server-matched SKILL.md reads).
  - tool calls, failed results, MCP calls by connector (`mcp__<connector>__…`), compactions and
    branch summaries: `thread_entries` (Pi's entries are permanent; compaction entries include
    Pi's automatic ones, which are not runs); primary key on (team, thread, entry).
  - approvals: `approvals_thread_idx`.
  - tokens, reasoning (+ estimated flag), models, cost: `run_usage` `kind IN ('run','eval')`,
    the same rows as the answers' footers (title/follow-up/learning calls excluded);
    `run_usage_thread_idx`. Read only: `run_usage` stays append-only.
  - refused by policy: `policy.denied` events, union `run_skipped_actions` (kept, scheduled runs).
  - failure codes: the run's `run.failed` event (`ORDER BY seq DESC LIMIT 1` per failed run).
  - time to first token: run start → first `text.delta`/`reasoning.delta` (`ORDER BY seq LIMIT 1`
    per run, stops at the first delta).
- **Null, not 0:** `reasoning` when no call reported or showed reasoning; `cost_usd` when calls
  were made and none had a price; `refused` when every turn's events were folded and no skipped
  action exists; `failures_by_code` when failed turns exist but none has kept events;
  `first_token`/`duration` with no samples. `events {kept, folded}` lets the panel say when
  event-based figures cover only recent turns.
- **Rate limit** 30/min per member like the context viewer (heavier than a plain read); row added
  to `docs/rate-limits.md`.
- **Layout:** a `<section>` "Conversation stats" with an `h2`, one `h3` + `<dl>` per group
  (Conversation, Tools, Tokens & reasoning, Performance); `title` tooltip on term and value, the
  meaning also as visually hidden text after the value; "Not recorded" in muted italics. At phone
  width the `.side` column is `display: contents`: gauge above the text, stats below it. Existing
  theme tokens only (no new tokens). Stats read with every open and Refresh (`attempt`), from the
  database, so they show while the sandbox wakes or when the context read fails.

## Figures that are not recorded anywhere (no tracking added)

- **Per-run reasoning effort/budget in tokens**: only the thinking level (`runs.thinking_level`:
  off/low/medium/high) is stored; shown as "Thinking on" by level.
- **Policy refusals, failure codes and time to first token older than 7 days**: they live only in
  `run_events`, which D18 deletes 7 days after a run ends. A durable copy would need new columns
  (e.g. `runs.failure_code`, `runs.first_token_ms`, a refusal count): question for Chris below.
- **Why a tool call failed** (beyond error/no error) and per-tool latency: only trace spans
  (KOBE-525), not stored.

## Open questions (for Chris or the coordinator)

1. Persist `failure_code`, `first_token_ms` and a policy-refusal count on `runs` so those figures
   survive the 7-day event fold? (Small migration + writes in the wire; not done.)
2. Should the panel (owner-only today) also open for shared readers with stats only?

## Performance

Seeded (throwaway test DB): 10 threads of 200 turns, 1,000,000 `run_events` (500 per turn),
3,000 entries per thread (half with 2-6 KB text), 1,000 `run_usage` rows per thread. The whole
read (11 statements, remote dev Postgres) took 145-195 ms. EXPLAIN ANALYZE: runs via
`runs_thread_idx`, usage via `run_usage_thread_idx` (1 ms), entries via the team+thread index
(4 ms), first token one PK row per turn (1.4 ms). The first refusals query (a join on
`run_events.type`) became a parallel seq scan of the whole `run_events` table (43 ms, growing
with every team's events); rewritten as a per-run `LATERAL … OFFSET 0` PK scan, so it grows only
with the thread's kept events (each turn's events read through the primary key; 28-48 ms
here for 100,000 events). No index migration needed; a partial index on `run_events (team_id, run_id) WHERE type =
'policy.denied'` would make it constant if needed later.

## Docs evaluation

Member-visible, so the guide changes in this PR: `docs/guide/chat/context-panel.md` gets a
"Conversation stats" section (groups, figure meanings, Not recorded, 7-day note, visibility, API
path) and the summary line. Spec note in `docs/specs/context-viewer.md`; row in
`docs/rate-limits.md`. No "For agents" change: agents in the sandbox have no access to the panel
or this route.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/shell/context-stats.test.tsx` (all four groups, values, Not
  recorded, tooltip, under the legend, re-read on Refresh, shown when the context fails).
- ac-2: `services/server/src/threads/threads.stats.db.test.ts` (aggregates on seeded runs, events,
  entries, usage, approvals, skipped actions; empty thread; folded events → null; 404 for another
  team's member, a teammate without a share and a team admin; 200 once shared with the team, 404
  after unsharing; 400 bad id); `stats.test.ts` (null rules, caps, rounding). No new tables, so
  the RLS probe suite is untouched.
- ac-3: the tests above, fake contract test, guide page.
