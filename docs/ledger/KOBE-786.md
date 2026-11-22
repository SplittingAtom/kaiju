# KOBE-786: Budgets chores: first team budget insert race, outbox claim filtered by team, daily email cap per person

- **Status:** in review (group 80, branch `group-80-budgets-email-cap`)
- **Branch / worktree:** `group-80-budgets-email-cap` in `../Kobe-g80`
- **Depends on:** none

## Decisions

- P2-33 (held: two first saves at once failed 23505 `team_budgets_team_idx`): `setTeamBudget`
  inserts with `onConflictDoNothing().returning()`, as `setMemberBudget` does. When a first budget
  was saved meanwhile, an approved Kobe MCP write (`expected` given) answers
  `changed_since_approval`; a plain save re-reads the row (now committed and visible) and applies
  its fields on top of it.
- P2-34(a) (held: with more than two batches of Site emails due, the team pass claimed none of
  its own): the claim's inner `SELECT … FOR UPDATE OF q SKIP LOCKED` joins `budget_alerts` and
  filters `team_id IS NOT DISTINCT FROM <context>`.
- P2-34(b) (held: an admin of three Workspaces and the Site got 35 in a day, the cap being per
  context through RLS). Owner decision (Chris, 2026-11-22): the cap is per person across the Site
  and every Workspace. New site-wide table `budget_email_daily_counts` (migration 0238):
  `(recipient_id, day, sent)`, PK `(recipient_id, day)`, FK to `users` (cascade), no team id and
  nothing from any Workspace, so reading it from any context leaks no Workspace content (only how
  many budget emails a person got on a UTC day). Not a team table, no RLS (tenancy `models.ts`
  `siteWide`, grants SELECT/INSERT/UPDATE/DELETE). No SECURITY DEFINER; no other team's outbox
  rows are read.
- The slot is taken **before** the send, not in the transaction that marks the email sent: one
  statement `INSERT … ON CONFLICT DO UPDATE SET sent = sent + 1 WHERE sent < 20 RETURNING day`,
  so concurrent replicas queue on the row and can never pass the cap (incrementing after the
  SMTP send could not enforce it, and holding a transaction open across the send would meet the
  pool's idle-in-transaction timeout). A failed send gives the slot back in the same transaction
  that reschedules or fails the email. A crash between send and "sent" leaves the slot taken and
  the email retried later (at least once, as before): the count can only be high, never low.
- Over the cap: unchanged behaviour, the email is `skipped` with `last_error = 'daily_limit'` and
  a warning is logged; it is not deferred to the next day.
- The day is `(now() AT TIME ZONE 'UTC')::date`, independent of the session time zone (tested with
  `TimeZone=Pacific/Kiritimati`). The retention pass (`runRetentionPass`, once per new pass, like
  the Site memory step) deletes days before yesterday (`budgetEmailCounts` in the result).
- Docs: `docs/guide/models.md` (Budgets: who is emailed at 80 %/100 %, at most 20 a day per
  person over the Site and every workspace) and the Budgets row of `docs/guide/admin/team-admin.md`.

## Open questions (for Chris or the coordinator)

- none (P2-34b decided 2026-11-22; ac-2 is superseded by the decision).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/budgets/outbox.db.test.ts`: P2-34a backlog test, three Workspaces +
  Site across two replicas (exactly 20 sent, 15 `skipped:daily_limit`), failed send gives the slot
  back, 35 concurrent reservations over two pools give exactly 20, UTC rollover + sweep, and the
  two P2-33 races (deterministic: a committed-later first save blocks the insert). All 7 failed
  before the fix (35 sent, team email not claimed, 23505) and pass after.
