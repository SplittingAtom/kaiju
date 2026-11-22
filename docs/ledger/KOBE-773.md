# KOBE-773: Legal hold on a user protects their uncommitted personal skill uploads in every team

- **Status:** in review (group 70)
- **Branch / worktree:** `group-70-hold-skills-sso-only` in `../Kobe-g70`
- **Depends on:** KOBE-740 (orphan sweep of skill bundle attempts)

## Plan

The orphan sweep (`services/server/src/retention/orphans.ts`) lists personal skill bundle attempts
(`<prefix>skills/users/<user>/<sha256>/<uuid>`) per team, for the team's members and workspace
users. Its hold check only saw holds in the swept team. Personal candidates now carry `anyTeam`, and
the delete batch skips them while an active hold names their owner in any team.

## Decisions

- No `scanTeams()` or per-team loop needed: `legal_holds` is a site-wide table (§5.4†, listed in
  `packages/db/src/tenancy/identity.ts`), readable without a team. The read runs inside the existing
  delete transaction, after `lockLegalHolds(tx)` (shared), so a hold approved mid-pass either waits
  for the batch or is seen by it — the same lock order as every team sweep. No team setting involved.
- Review g70 (L6): a team-wide hold on any team the user is a member of keeps them too, as for
  portable memories: `snapshotPortableHolds` reads the held teams' members (one `withTeam` per
  held team) before the delete transaction; under the lock `portableHoldsUnchanged` re-checks the
  set, and if it changed nothing personal goes that pass. A membership added between snapshot and
  delete is not seen (same accepted gap as portable memory).
- Pending holds do not protect (only `active`, as everywhere).

## Docs

`docs/guide/reference/retention-and-deletion.md`: unfinished uploads go after a day; a hold on you
in any workspace keeps your unfinished personal skill uploads.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-3: `orphans.db.test.ts` "personal skill bundles under a hold in another team (KOBE-773)":
  hold on the member in a second team, sweep of the first team keeps their bundle and removes
  another user's (red before the change, green after).
- ac-2: same test: released hold (approved release) → next sweep removes it.
- Also: a hold on another user, a team-wide hold in a team they are not in, and a pending hold do
  not keep it; a team-wide hold in another team they are a member of does (review L6).
- ac-4: guide page updated.
