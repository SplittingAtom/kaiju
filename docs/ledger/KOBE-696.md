# KOBE-696: Delete a member's connector grants when they leave a team or are deactivated

- **Status:** in review (group 52)
- **Branch / worktree:** `group-52-audit-split-team-guard` in `../Kobe-g52`
- **Depends on:** KOBE-701 (the audit change lands in `audit/events/connector-grants.ts`)

## Decisions

- Owner decision (Chris, 2026-11-20, ac-1): delete. No call to an upstream OAuth revocation
  endpoint. No migration (a sibling branch adds migrations): the cleanup runs in an existing sweep.
- `mcp.grant.removed` gains optional `userId` and `reason` (`member_removed`, `deactivated`,
  `deprovisioned`); older rows and the user's own / connector-change removals carry neither.
- Paths that end a membership, all checked:
  - `removeMemberInTx()` (`teams/members.ts`) is the only code that deletes `team_members`; it now
    deletes the member's grants in that team in the same transaction. Callers: team admin
    (`DELETE /v1/team/members/:id`), Site admin (`DELETE /v1/site/teams/:t/members/:id`, also the
    Kobe admin MCP through those routes), identity-provider mappings (`sso/access.ts`, reason
    `deprovisioned`), the Skill reviewer grant (`skills/registry/grants.ts`). Actor: the request's.
  - Deactivation (Site admin, SCIM `active: false`, SCIM DELETE) keeps memberships; a new
    `deactivated` lifecycle hook `connector-grants` (`deps.ts`) deletes the user's grants in every
    team they belong to, one `withTeam()` per team, actor system, reason `deprovisioned` when
    `users.deactivated_via` is `scim:*`, else `deactivated`. A failed hook is reported in
    `incompleteSteps`; the sweep finishes it.
  - No self-leave exists; every team role keeps connector access; roster transfer moves agents,
    not memberships; team or user deletion cascades (FK).
- Cleanup (ac-3): `sweepDepartedGrants()` (`connectors/grant-departures.ts`) runs in every
  offboarding sweep (`SweepSummary.grants`): per team in `withTeam()`, grants whose owner is no
  longer a member or is deactivated are deleted and audited (actor system). Idempotent; skipped
  while `KOBE_RETENTION_PAUSED` like the rest of the sweep.
- Reactivation does not restore anything: the member enters keys again (guide says so).

## Evidence (acceptance criteria → test or command output)

- ac-2: `services/server/src/connector-grant-departures.db.test.ts`: team admin removal, Site
  admin removal, provider removal (`deprovisioned`), re-add has no key, Site admin deactivation
  (all teams, `deactivated`, stays gone after reactivation), SCIM deactivation (`deprovisioned`).
  7 of 8 red before the implementation, 8/8 green after.
- ac-3: same file, "the offboarding sweep deletes grants left behind": non-member and deactivated
  owners' grants deleted, active members' kept, second run deletes 0; runs inside `sweep()`.
- ac-4: guide `connectors-and-apps.md` (Add your own key), `admin/team-admin.md` (Members and
  roles), `admin/site-admin.md` (Users), `admin/single-sign-on.md` (SCIM deactivation);
  `docs/audit-log.md` row for `mcp.grant.removed`.
- Checks: `pnpm verify` green except the load-sensitive `model-gateway budget-gate.test.ts` timing
  test (passes alone, 32/32; untouched code); `@kobe/server test:db` 3295/3295,
  `@kobe/db test:db` 2044/2044.
- Review follow-up (LOW 3-5): the sweep judges the departure inside one DELETE … RETURNING (a
  member re-added meanwhile keeps a key they stored), caps each team's pass
  (`GRANT_SWEEP_LIMIT` 500) and logs and skips a failing team; reactivation deletes any grants a
  failed deactivation step left (`reactivated` reason, lifecycle hook). Tests in
  `connector-grant-departures.db.test.ts` (cap, returning member, reactivation); the per-team
  failure path has no test (no seam to make one team's transaction fail).
