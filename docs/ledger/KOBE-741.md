# KOBE-741: Retention sweeps for tables that grow without bound (review STO-10)

- **Status:** in review (group 63, branch `group-63-storage-reclaim-retention`)
- **Branch / worktree:** `group-63-storage-reclaim-retention` in `../Kobe-g63`
- **Depends on:** none

## Plan

Owner decision (2026-11-20, ac-1): events 30 days, READ notifications 180 days, `run_usage` 13
months, scan/eval history 12 months; the audit log is kept (no sweep). Each period is a chart
value (`retention.sweeps.*`) → env (`KOBE_RETENTION_EVENTS_DAYS`,
`KOBE_RETENTION_READ_NOTIFICATIONS_DAYS`, `KOBE_RETENTION_RUN_USAGE_MONTHS`,
`KOBE_RETENTION_EVAL_HISTORY_MONTHS`; 0 = off) → zod config → step 11 of the nightly retention pass
(`services/server/src/retention/table-sweeps.ts`, wired in `job.ts`). No new timer.

## Decisions

- **What `events` is, and why deleting it is safe.** `events` (D15) holds background happenings:
  `schedule.fire` / `schedule.skip`, `egress.blocked` (proxy → relay), and similar. It is **not**
  the conversation record and not the replay source: a thread's history is `thread_entries` (Pi's
  entries mirrored as the run goes, kept by the team's retention period), and a run's live,
  replayable stream is `run_events`, already compacted 7 days after the run ends
  (`retention/compaction.ts`; the stream route answers 410 `events_compacted` and clients render
  the entries). So no thread or resumable run reads `events`. The two readers that do:
  - the scheduler's skip dedupe reads each schedule's **latest** fire/skip
    (`scheduler/fire.ts` latestEvent) → the sweep never deletes a schedule's latest fire/skip;
  - the egress relay works through **pending** `egress.blocked` events → only `processed` and
    `failed` events are swept; `pending` and `scheduled` never are.
    The fire dedupe index (`events_schedule_fire_uniq`) only matters inside the scheduler's grace
    window (≤ 24 h, `KOBE_SCHEDULER_GRACE_MINUTES` max 1440), so the minimum period is 2 days.
- **`run_usage` was append-only by trigger** (KOBE-43). Migration `0239_run_usage_retention`
  (custom) lets a DELETE through only when the transaction set `kobe.run_usage_retention = on`
  (transaction-local `set_config(..., true)`) **and** the row is older than 90 days; updates are
  still refused. Config minimum is 4 months so the floor never bites a valid setting. Budgets read
  `model_spend_daily` (insert trigger; never decremented), so spend history survives; the Usage
  pages and the context gauge read `run_usage`, so they show at most 13 months back (an old thread
  revived after 13 months shows no context-gauge reading until its next model call).
- **"Scan/eval history" = `orbit_evals`** (agent evals): finished evals older than the period,
  except each agent's latest (roster score, `agents/inventory.ts`) and any with `version` set
  (per-version score, `agents/eval/store.ts` versionScores). Skill eval runs already have their own
  retention (`retention/skill-evals.ts`). Left out on purpose: `skill_hash_checks` (an identity
  table, one row per stored hash, read by the blocklist; not history), `skill_rescan_runs` (one
  row per scanner rule set, a handful per year; would need a new DELETE grant on a site table),
  `registry_review_events` (review decisions, audit-like). `egress_requests`,
  `break_glass_notifications` were not in the decision.
- **Legal holds:** every batch takes the legal-hold lock first; rows of a held member are kept
  (`memory_legal_hold_covers(team, user)`: member hold or team-wide hold). `events` name no member,
  so any active hold in the team keeps all of them (conservative).
- **Batching:** one `DELETE … WHERE id IN (SELECT … ORDER BY … LIMIT 1000)` per short
  `withTeam()` transaction (`lock_timeout` 5 s, job statement timeout), at most 50 batches per table
  per team per pass; the pass's own budget/stop also applies. Audited per batch:
  `retention.table_swept` `{table, rows}`.
- **Indexes:** `0238_retention_sweep_indexes` (custom, `-- kobe:no-transaction`, CONCURRENTLY):
  `events_retention_idx` (team_id, created_at) WHERE status IN ('processed','failed') and
  `notifications_read_idx` (team_id, read_at) WHERE read_at IS NOT NULL. SQL-only (not in the
  drizzle schema, noted there), so this branch has no hand-written migration and `db:rebase`
  renumbers both. `run_usage_team_at_idx` and `orbit_evals_agent_idx` already serve the others.
- **A pass without `tableSweeps`** (tests, tools) runs no sweep; production always passes the
  config (defaults = the owner's periods).
- **Docs:** no "Retention and deletion" guide page on main, so the content went into
  `docs/guide/admin/site-admin.md` (new section "What Kobe deletes on its own"); install.md
  "Retention sweeps" (values, ranges, holds, audit-log growth note); audit-log.md row.

## Open questions (for Chris or the coordinator)

- Move the guide section to the "Retention and deletion" page once that page lands.

## Evidence (acceptance criteria → test or command output)

- ac-1: owner decision above.
- ac-2: `services/server/src/retention-table-sweeps.db.test.ts` (12 tests: each table, schedule
  latest kept, pending/scheduled/unread kept, holds, cross-team isolation, append-only outside the
  sweep and for rows < 90 days, batches + cap + audit, switches, full pass);
  `config.test.ts` (defaults, 0 = off, ranges); `charts/kobe/tests/retention-paused.test.ts`.
- ac-3: guide section + install.md as above.
