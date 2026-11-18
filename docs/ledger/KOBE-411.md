# KOBE-411: SMD4: Quality flags and queue health

- **Status:** committed locally on `kobe-411-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-411-sm` in `../Kobe-wt411` (on `kobe-403-sm`)
- **Depends on:** KOBE-408, KOBE-275 (answer_feedback), KOBE-397/402/403 (queues), KOBE-389/396 (passes)

## Plan

No migration, no protocol change: computed on read, wire types server-local (like settings-wire).

- Server `services/server/src/memory/quality/`: `flags.ts` (pure rules), `items.ts` (per-item
  signals), `queues.ts` (queue health), `passes.ts` (Learn's numbers). Routes
  `routes/memory-quality.ts`: `/v1/memory/quality/{items,queues,passes}` (Workspace) and
  `/v1/site/memory/quality/{items,queues,passes}` (Site); two mount lines in `app.ts`.
- Site setting `unused_after_days` (7–3650, default 90) in the `memory.settings` document; audited
  by the existing `memory.site_settings_changed` (names the changed setting).
- Web: `components/memory/quality/` (`MemoryQuality`, `ItemFlags`, `MyMemoryQuality`),
  `lib/memory/quality-api.ts`. Shared files touched by one import + one tab each: Workspace and
  Site memory pages (**Quality** tab), Me page (section under the memories); Site settings form
  gains **Not used after (days)**.

## Decisions

- **Flags.** _Check this_: runs with ≥ 1 thumbs down (any rater, counted once per run) / runs that
  received the item > 0.3 and runs ≥ 10, lifetime. _Not used lately_ (`unused`): no run received it
  for `unused_after_days`; never-received items count from `created_at`. Active items only.
  Never acts: no sweep, no archive (db test asserts nothing changed status).
- **"Stale" vs "unused".** KOBE-386 already defines `stale` (not changed for `stale_after_days`)
  with a list filter. To avoid two meanings, the ticket's "stale when not received" is a separate
  flag `unused`, UI "Not used lately", with its own setting `unused_after_days` (default 90).
- **Scopes.** `team` (Workspace curators), `user` (the caller's own, Me page), `site` (Site
  curators; Policy included). Portable items are not covered (runs live in every Workspace; the
  Me page shows the person's Workspace-only memories) — open question.
- **Site sums across Workspaces** with `scanTeams` (one query per team, team tables stay behind
  RLS, no bypass): per item `count`, `max(created_at)`, down-run count only. Pass signals per
  Workspace: numbers + Workspace name; never statements, threads, runs or raters (test checks a
  candidate payload string does not appear).
- **Queue health.** Pending = current state; oldest = min wait start; median = percentile_cont(0.5)
  of `decided_at − wait start` over decisions by a person (`decided_by` set) in the last 30 days;
  expiries are not decisions. Workspace: `memory_proposals` (approved/rejected), project
  suggestions (approved/dismissed). Site: `site_memory_proposals` `awaiting_site`, timed from
  `coalesce(team_confirmed_at, created_at)` (last confirmation, so a round of changes restarts
  the clock); decisions approved/merged/rejected (request changes is not a decision). Site-proposal
  confirmations (`awaiting_team`) left to KOBE-404's queue.
- **Pass signals** (passes finished in the last 30 days, `memory_learning_passes_finished_idx`):
  passes, failed, shown (candidates stored), saved, proposed, suggested, dismissed, expired, open.
  _Edited before save_ has no column: counted from `audit_log` `memory.candidate.accepted` events
  with `edited = true` for those passes (ids/flags only). No migration.
- **Access.** Read-only GETs; `refuseAgentWrites` + `assertAgentRead` as other memory routes;
  members get 403 on Workspace numbers; Team admins get 403 on Site numbers.
- **Bounded queries.** Items capped at 1,000 (the SM21 scope limit), uses aggregated with
  `item_id = ANY(...)` on `run_memory_items_item_idx` / run PKs and the `answer_feedback
(team_id, run_id, user_id)` unique index. No new index needed.

## Open questions (for Chris or the coordinator)

- Portable preferences' signals (sum over the person's Workspaces) — follow-up if wanted.
- The audit query for _edited before save_ filters `audit_log` by action/team/time; fine at
  current sizes, but it is the one query that grows with total audit volume.
- Flags are lifetime ratios; a recent-window ratio may be more useful once data exists.

## Docs

`docs/guide/memory.md` (new "Memory quality" section; Me page paragraph; Site settings),
`docs/guide/admin/team-admin.md` (Memory row, Quality paragraph), `docs/guide/admin/site-admin.md`
(Memory page Quality, Not used after). /llms.txt is generated from the guide.

## Evidence (acceptance criteria → test or command output)

- ac-1 flags computed/shown, nothing archived: `services/server/src/memory-quality.db.test.ts`
  "item signals and flags", `memory/quality/flags.test.ts`, web `memory-quality.test.tsx`.
- ac-2 queue health on seeded data: db test "queue health" (median 20 h Workspace, 2 h Site).
- ac-3 pass signals: db test "pass signals" (Workspace exact numbers; Site totals per Workspace).
- ac-4 docs: above.
- Performance: db test "performance (seeded)": 1,000 items, 2,000 runs, 20,000 run records,
  400 thumbs-down runs, 20 HTTP calls: p95 ≈ 65 ms over HTTP (list endpoint baseline ≈ 25 ms); the SQL alone ≈ 10 ms. A per-row `EXISTS` on RLS-guarded `answer_feedback` was costed high enough to trigger Postgres JIT (≈ 0.5 s compile), so down-rated runs are one hashed CTE.
