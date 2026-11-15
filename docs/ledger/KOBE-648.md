# KOBE-648: SMA11c: Site-level break-glass for portable memories

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** phase 1 (migration alone) and phase 2 (feature) committed locally; not pushed
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
- **Reads** (`readPortableWithSiteBreakGlass`, `packages/db/src/break-glass/portable-read.ts`): one
  transaction locks the grant `FOR SHARE` (approved, in window by statement time, requester still an
  active site admin), finds the person's Workspaces under each team's own RLS (as `scanTeams`), writes
  `governance.site_break_glass.read` once with no team (Site log) and once per Workspace (scope
  `any`), sets `transaction_read_only`, then reads only `owner_user_id = subject`. Out-of-grant item →
  rollback with its audit rows. Portable rows stay RLS-less (spec: app-role grants, server filters);
  every other path is owner-only (`memory/items/location.ts`), so this is the only cross-person path.
- **Audit**: lifecycle events `governance.site_break_glass.*` are Site-scope; reads are fanned out.
  Under legal hold no row names the person and Workspace rows omit the item id.
- **Notifications** follow the Workspace grant's rule with the person's Workspaces as "the team":
  requested → other site admins; approved / ended-while-active → the person (unless legal hold), the
  team admins of each of their Workspaces, site admins; denied/withdrawn/lapsed → requester. Own outbox
  table, delivered by the existing break-glass sweeper (which also expires Site grants).
- **API** `/v1/site/portable-break-glass` (site.break_glass.request / .approve), GET-only reads
  `/:id/items`, `/:id/items/:itemId`. **Console** Site → Governance → Portable memory access.
- Self-approval: allowed only when no active site admin other than the requester and the subject.

## Open questions (for Chris or the coordinator)

- Team admins of the person's Workspaces are emailed on approval/end (mirrors D10's "team admins are
  notified"); drop them if Chris prefers only the person + site admins.
- Kobe admin MCP has no tools for this (break-glass is out of its scope, kobe-admin-mcp.md:196).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/site-break-glass-upgrade.db.test.ts` (9 tests: pending-only insert by a site
  admin, request immutable, two-person, subject can't decide, single-admin self-approval, deny /
  withdraw / revoke, expiry only after window or deadline, no DELETE/TRUNCATE, pre-upgrade portable
  rows and Workspace grants untouched, invoker + pinned search_path). catalog, probe,
  drizzle-privileges, app-role-capabilities, break-glass, migrate: 1138 passed.
- ac-2: `packages/db/src/site-break-glass.db.test.ts` (7: refused without/pending/revoked/expired/other
  admin/deactivated admin; only subject's rows; other person's item not found and rolled back);
  `services/server/src/site-break-glass.db.test.ts` (7, HTTP end to end incl. no write routes).
- ac-3: same tests: Site row + one row per Workspace (not other teams), visible in `/v1/team/audit`;
  legal hold hides the person.
- ac-4: `docs/guide/admin/site-admin.md` (summary → /llms.txt), `team-admin.md`, `memory.md`;
  `docs/audit-log.md` rows; web test `apps/web/components/admin/portable-break-glass-page.test.tsx`.
