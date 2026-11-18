# KOBE-653: SMC6: Phase C sweeps — Site proposal expiry and reminders

- **Status:** committed locally on `kobe-653-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-653-sm` in `../Kobe-wt653`, on `kobe-403-sm` (KOBE-402 #597,
  KOBE-403 #599 in the merge queue)
- **Depends on:** KOBE-403, KOBE-645, KOBE-647. **Migration:** none.

## Plan

- `services/server/src/retention/site-proposals.ts`: `sweepSiteProposals`, team step
  `site_proposals` of the nightly pass (after `memory_learning`), `TeamPassResult.siteProposals`.
- `services/server/src/notifications/site-proposal-relay.ts`: `relaySiteProposals`, run first in
  `sweepMemoryReminders` (KOBE-645 reminder job, every 15 min, one replica under its lock).
- `notifications/memory.ts`: at send a Site proposal reminder needs the proposal still waiting at
  its step (not expired); a Site-wide hold leaves Site proposal reminders owed, untouched.
- Audit: `memory.site_proposal.decided` gains outcome `expired` (packages/db, `docs/audit-log.md`).

## Decisions

- **Expiry.** Open (`awaiting_team`, `awaiting_site`, `changes_requested`) past `expires_at`
  (column default, 30 d from creation; KOBE-403 never moves it) → `expired`, `updated_at` only
  (`decided_*` keep the last request-changes curator; views hide them on expired). Batches of 200
  in one `withTeam(from_team)` transaction: `lock_timeout 5s`, `lockLegalHolds`, Site-wide hold
  check, `FOR UPDATE SKIP LOCKED`; reminders settled in the Workspace; `memory.site_proposal.decided`
  (system, outcome `expired`, round) per proposal; `memory.site_proposal.expired` to the proposer
  and `team_confirmed_by` (if any) through `notifyMemoryAll`, last in the same transaction, so once
  across reruns and replicas. Members who left are skipped by the machinery.
- **Holds.** A Site-wide hold (KOBE-647) freezes Site proposals: no expiry, no relay, no re-arm,
  and the reminder sweep leaves their rows unsent (they go after release). A hold covering the
  proposer (`legal_hold_covers`, person or Workspace, as KOBE-651) skips expiry and the weekly
  re-arm. Relay of the `confirmed` notice still runs for a held proposer (it changes none of their
  records).
- **Reminders = weekly windows.** KOBE-403 registers one reminder per step for members of the
  proposing Workspace. The relay pass re-arms any Site proposal reminder sent ≥ 7 days ago while
  the proposal still waits at that step (`sent_at` NULL, due now): at most one reminder per person
  per week until the step ends. "Settled when the step ends": KOBE-403 settles in the Workspace;
  everywhere else the send re-checks the step and drops the row.
- **How Site curators get notices (the KOBE-403 gap), no migration.** Elsewhere Site-level
  notices are email outboxes (egress site-scope requests, Site break-glass) or in-app rows written
  under the recipient's team (`skills/site-edit/site-notify.ts`). `notifications` and
  `memory_reminders` are team-scoped (RLS; reminders FK to `team_members`), and the bell lists the
  active team. So: a Site admin or Site memory steward who is **not** an active member of the
  proposing Workspace gets the `confirmed` notice and its reminder in their **home Workspace**
  (last active if still a member, else first by id). Written per home Workspace in its own
  `withTeam()`; the reminder row (`memory_reminders_once`, created after `team_confirmed_at`) is
  the once-per-round marker: inserted first (`ON CONFLICT DO NOTHING`), the notice only when the
  insert happened, same transaction. A new confirmation round replaces the old row and relays
  again. Ids only, **no actor** (the confirmer is not a member there; wall), link = Site console.
  Latency: the 15-minute reminder pass (not immediate).
- **Not covered:** a curator in no Workspace (owner-only accounts) has no bell; they see the Site
  queue. Email would need an outbox table (migration) or best-effort mail; left open.
- KOBE-406 wall probe: relayed rows carry `memory_object_id` + kind only (`actor_user_id` NULL).

## User-facing docs

`docs/guide/memory.md`: How long memories are kept (Site proposals expire after 30 d; holds),
Legal hold on Site memory (proposals frozen), Memory in your notifications (weekly reminders per
step; curators outside the Workspace hear in their own one). `/llms.txt` is generated from the
guide. `docs/audit-log.md` (`expired` outcome). No SM28 retention table exists in the repo docs.

## Open questions (for Chris or the coordinator)

1. Weekly repeat vs one reminder per step: I read "7-day reminders … once per reminder window" as
   weekly while the step waits (days 7, 14, 21, 28). Easy to drop the re-arm if one is meant.
2. Curators with no Workspace membership get no notice (no site-level bell). Email them?
3. Team admins promoted after a step started get no reminder for it (KOBE-403 registers at the
   transition); not added.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/memory-site-proposal-sweeps.db.test.ts` › expiry (each open state,
  rounds), reminders (awaiting_team weekly, awaiting_site relay + reminder, new round, decided,
  expired dropped).
- **ac-2** same file › holds (Site-wide freezes expiry and reminders; person and Workspace hold
  keep proposals; held proposer not re-armed).
- **ac-3** same file: second pass and two concurrent runners (retention and reminder pass) write
  each notice and audit once.
- **ac-4** docs above.
