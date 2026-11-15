# KOBE-648: SMA11c: Site-level break-glass for portable memories

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress — phase 1 (migration alone) committed
- **Branch / worktree:** `kobe-648-sm-break-glass` in `../Kobe-wt648`
- **Depends on:** KOBE-378, KOBE-647 (migrations 0224-0225)

## Plan

1. Migration alone: `0226_site_break_glass` (generated: grants table + outbox) and
   `0227_site_break_glass_guard` (custom SQL: lifecycle / two-person trigger). Upgrade test.
2. Feature: Site console request/approve/deny/revoke; portable break-glass read in `@kobe/db`
   (lock grant, audit Site log + each of the person's Workspaces, read-only transaction);
   notifications; expiry sweep; guide + `/llms.txt`.

## Decisions

- **Separate site-wide tables `site_break_glass_grants` + `site_break_glass_notifications`, not a
  nullable `break_glass_grants.team_id`.** `break_glass_grants` is read by `break_glass_active_grant`,
  the `break_glass_read` RLS policies on threads/entries, `readWithBreakGlass`, the store, the team
  audit view and the outbox, all of which assume a team; a team-less row would change their meaning,
  and the catalog forbids mixed nullable team_id. Same precedent as `site_legal_holds` (KOBE-647).
  No team_id, no RLS (site-wide like `break_glass_grants`), app role gets SELECT/INSERT/UPDATE only
  on both (never deleted), reuses the `break_glass_status` / `break_glass_notification_status`
  enums and the Workspace grant's CHECKs.
- **`subject_user_id NOT NULL`**: a Site grant names exactly one person; no team or thread scope.
  CHECKs: subject ≠ requester, subject ≠ approver, two-person shape, window ≤ 24 h.
- **Guard = copy of `break_glass_grants_guard()` with the subject always named**: the subject can't
  approve, deny or revoke (even as a site admin); self-approval is allowed only when no other active
  admin besides the subject exists (`legal_hold_other_admin_exists(admin, subject)`, which also
  share-locks the admins' rows), under the site admin set lock. `break_glass_grants_guard()` untouched.
- Two migration files (generated + custom) because `db:rebase` regenerates generated files and would
  drop hand-added SQL (same split as 0224/0225).

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/site-break-glass-upgrade.db.test.ts` (9 tests: pending-only insert by a site
  admin, request immutable, two-person, subject can't decide, single-admin self-approval, deny /
  withdraw / revoke, expiry only after window or deadline, no DELETE/TRUNCATE, pre-upgrade portable
  rows and Workspace grants untouched, invoker + pinned search_path). catalog, probe,
  drizzle-privileges, app-role-capabilities, break-glass, migrate: 1138 passed.
