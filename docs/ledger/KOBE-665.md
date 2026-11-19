# KOBE-665: Site proposals: a legal hold stops a Workspace delete from removing them

- **Status:** committed locally on `kobe-665-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-665-sm` in `../Kobe-wt665`
- **Origin:** Gate C decision 1 (Chris, 2026-11-18); follow-up to KOBE-402 open question 1

## Plan

Migration ticket, lands alone. `site_memory_proposals.from_team_id → teams` changes from
`ON DELETE CASCADE` to `ON DELETE RESTRICT` (schema in
`packages/db/src/schema/site-memory-proposals.ts`; generated migration
`packages/db/drizzle/0234_site_memory_proposals_restrict.sql`, drop + re-add of the one FK, no
data change, no function, no SECURITY DEFINER). Registry reason updated in `tenancy/memory.ts`.

## Decisions

- **RESTRICT, not NO ACTION.** RESTRICT is checked immediately and cannot be deferred, so a
  delete of a Workspace with any Site proposal (waiting, withdrawn, expired or decided) fails at
  once with SQLSTATE `23503` on `site_memory_proposals_from_team_id_teams_id_fk` (Postgres reports
  RESTRICT as a foreign-key violation too). NO ACTION would also refuse but reads as "nobody
  decided"; RESTRICT states the intent.
- **Applies to every state**, not only open proposals: decided/withdrawn rows are the record a
  hold may need, and the app role has no DELETE on the table (unchanged), so only an explicit,
  owner-level step can remove them.
- **No server path deletes a Workspace today.** Checked: no `DELETE FROM teams` /
  `delete(teams)` outside `*.db.test.ts`, and no `DELETE` route on a team resource in
  `services/server` or `apps/web`. The constraint is structural protection for a manual DB delete
  and for any future feature.

## Rule for any future Workspace deletion (ac-2)

Before deleting a Workspace (team row), the deleting path must, in one transaction holding the
legal-hold lock (`lockLegalHolds`, as the retention steps do):

1. **Check legal holds** and refuse while any applies: the Site-wide hold (KOBE-647, freezes Site
   memory and proposals), a hold on the Workspace, or a hold on a person (`legal_hold_covers`) who
   proposed, confirmed or decided one of the Workspace's Site proposals.
2. **Handle Site proposals explicitly**: settle open ones (`awaiting_team`, `awaiting_site`,
   `changes_requested`) as `withdrawn`/`expired` with the usual notices, reminder settlement and
   `memory.site_proposal.decided` audit (as `retention/site-proposals.ts` does), then remove the
   Workspace's proposals as the table owner (the app role has no DELETE) and audit the removal.
3. Only then delete the team; the RESTRICT key fails the delete if step 2 was skipped.

Documented for admins in `docs/guide/memory.md` (Legal hold on Site memory → "Workspaces with
Site proposals are not deleted") and pointed to from `docs/guide/admin/site-admin.md` (Teams).

## Other Site-wide team-referencing tables (TEAM_REFERENCING_SITE_WIDE)

Checked every entry's FK to `teams` (from the migrations' SQL):

| Table                   | Key → teams        | ON DELETE                  | Recommendation                                                                                                                                                                                |
| ----------------------- | ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_memory_proposals` | `from_team_id`     | ~~CASCADE~~ → **RESTRICT** | Changed here.                                                                                                                                                                                 |
| `sso_access_mappings`   | `team_id`          | CASCADE                    | Keep. Configuration (IdP group → team role), no content and nothing a hold protects; a mapping to a deleted team is meaningless. A future Workspace delete should audit the removed mappings. |
| `site_skill_settings`   | `registry_team_id` | SET NULL                   | Keep. A pointer; SET NULL leaves the Registry "not ready" (SK21).                                                                                                                             |
| `legal_holds`           | `team_id`          | NO ACTION                  | Keep. Already blocks deleting a Workspace that has (or had) a hold.                                                                                                                           |
| `break_glass_grants`    | `team_id`          | NO ACTION                  | Keep. Already blocks the delete; grants are audit history.                                                                                                                                    |
| `user_last_teams`       | `team_id`          | NO ACTION                  | Consider CASCADE later: a pure pointer; NO ACTION blocks a Workspace delete for a convenience row (a future delete path must clear it). No hold concern.                                      |
| `session_active_teams`  | `team_id`          | NO ACTION                  | Same as `user_last_teams`.                                                                                                                                                                    |
| `audit_log`             | (no FK)            | —                          | Keep. History by design.                                                                                                                                                                      |
| `budget_alerts`         | (no FK)            | —                          | Keep.                                                                                                                                                                                         |

None other has the hold-bypassing CASCADE pattern; only `site_memory_proposals` changed.

## User-facing docs

`docs/guide/memory.md` (new paragraph under "Legal hold on Site memory") and
`docs/guide/admin/site-admin.md` (Teams: no way to delete a workspace, link to the rule). Nothing
in the UI changes.

## Evidence

- **ac-1** `packages/db/src/site-memory-proposals.db.test.ts`: "block deleting their Workspace
  (RESTRICT, KOBE-665)" (FK `confdeltype = 'r'`; delete refused with 23503 on that key with an open and with
  only a withdrawn proposal; succeeds after the proposals are removed) and "leave a Workspace that
  never proposed free to be deleted". The old cascade test was replaced.
- **ac-1** `packages/db/src/tenancy.test.ts` KOBE-402 case: the drizzle FK is `restrict` and the
  registry reason says ON DELETE RESTRICT.
- **ac-3** catalog + cross-team probe + migrate suites green (see commit message). Server db tests
  that create Site proposals (`memory-site-proposals`, `memory-site-proposal-sweeps`,
  `site-wall-probe`, `memory-quality`) never delete teams; no fixture relied on the cascade. The
  other db tests that delete teams create no Site proposals.
