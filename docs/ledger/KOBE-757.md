# KOBE-757: GIT-1: Tables, sealing purpose, permission `team.git.manage`, Site switch and host limit; probe fixtures

- **Status:** in review (not pushed; the coordinator opens the PR)
- **Branch / worktree:** `group-95-git-1-foundation` in `../Kobe-g95` (stacked on group 88)
- **Depends on:** spec `docs/specs/workspace-git.md` (approved 2026-11-21)

## What ships

- **Tables** (area `packages/db/src/tenancy/git.ts`, schema `packages/db/src/schema/git.ts`,
  migrations `0248_git_connections` generated + `0249_git_rls` custom; renumbered on landing):
  - `git_connections`: provider, canonical https base URL, organization (unique per base URL,
    ignoring case: G2), display name, credential kind, `credential_sealed` + `credential_key_id`,
    token hint, GitHub App ID / installation ID in clear (G5), access level (off/read/read_write,
    default read), repository defaults (visibility private|internal, name prefix, default branch),
    push limit (default 1 GiB, G11), direct commits (GQ11), agent list (GQ8, null = all),
    capabilities (G4), health and token-expiry fields (G6), created/updated by.
    CHECKs: an App only on GitHub with both ids, a token never with them; envelope text only.
  - `git_repositories`: connection, host repo id, `org/repo`, default branch, project (unique: one
    Repo per project), origin (tool|conversion|link), host state, private, branch protection (G14),
    mirror head and refresh time (G17).
  - `projects.kind` (`project` | `repo`, default `project`).
  - Both: `team_id NOT NULL`, ENABLE + FORCE RLS, canonical `team_isolation` policy only (no
    break-glass policy: no member content, and the credential must never be readable that way).
    SQL-only keys `(team_id, connection_id)` and `(team_id, project_id)` with
    `ON DELETE SET NULL (column)`: a removed connection or deleted project leaves the repository's
    record (G20). App-role grants come from the tenancy registry (team table privileges).
- **Sealing**: envelope (KOBE-107) kind **`git-hosts`**, context = team + connection id
  (`packages/db/src/git/credential.ts`: `sealGitCredential`, `openGitCredential` (checks the row's
  credential kind), `rewrapGitCredential`, `gitCredentialHint`). Sealed JSON is a strict
  discriminated union (`access_token` | `github_app` private key). Registered in the start-up
  sealed-key check (`services/server/src/startup/sealed-keys.ts`, family "git host credentials").
- **Permission** `team.git.manage` → `team_admin` (Workspace admins; there is no separate owner
  rank in the team ladder), in the matrix test and the regenerated `openapi.json`.
- **Site ceiling** (G3): `site_settings` keys `git.connections_enabled` (default on) and
  `git.allowed_hosts` (JSON list of egress-style patterns, empty = any; an unreadable value allows
  nothing). Reader + check in `packages/db/src/git/site-settings.ts` (`readGitSiteSettings`,
  `decideGitHost`, `parseGitBaseUrl`, `gitAllowedHostsSchema`); stored through
  `PUT /v1/site/settings` (`gitConnectionsEnabled`, `gitAllowedHosts`; `site.settings.manage`)
  via `services/server/src/git/site-settings.ts`, audited `site.settings.updated` with settings
  `git_connections` / `git_allowed_hosts` (value = count, `hosts` = patterns).
- **Shared types for GIT-2/3/4**: all from `@kobe/db` — `GitProvider`, `GIT_PROVIDER_VALUES`,
  `GitCredentialKind`, `GIT_CREDENTIAL_KINDS_BY_PROVIDER`, `GitAccessLevel`, `GitCapabilities`,
  `GitConnectionRecord`, `GitRepositoryRecord`, `GitCredentialSecret`, `GitCredentialRef`, limits
  (`GIT_CONNECTIONS_MAX` = 5 etc.), tables `gitConnections` / `gitRepositories`.

## Decisions

- Provider enum is the spec's `github | gitea | forgejo`; GitHub Enterprise Server is `github`
  with its own base URL (GQ6), not a fourth value.
- The 5-connection cap (G2) is a server check for GIT-4 (`GIT_CONNECTIONS_MAX`), not a trigger.
- No `git.*` audit events yet: GIT-1 adds no connection or repository writes; GIT-4 adds the
  `git.connection.*` area when it writes rows. The only state change here is the Site ceiling.
- `scripts/site-identifiers.mjs` allows `githubInstallation*` / `githubAppInstallation*`
  (GitHub's noun for an App on an organization, not the old "install" scope).

## Registrations (backup, retention, erase, hold)

- **Backup** (`kobe-backup/*`): nothing to register; every `public` table is backed up unless
  listed in `packages/cli/src/excluded.ts`. The credential stays in the backup as ciphertext, like
  connector grants; after a restore it opens only with the same envelope Secret (start-up check
  names it).
- **Retention**: no sweep; rows live until disconnect / unlink. Repositories on the host are
  outside Kobe's retention and erasure (spec §9; the guide says so in GIT-13).
- **Erase / Workspace deletion**: both tables cascade from `teams`; `created_by` / `updated_by`
  reference `users` like other team tables (accounts are deactivated, not deleted).
  `docs/specs/delete-workspace.md` already names "the Workspace git connections and their sealed
  credentials" in step 2 and its coverage test will force them in.
- **Legal hold**: no guard; neither table holds member content (a Repo's project keeps its own
  hold guards; G16's "refused under hold" is GIT-9).
- **Break-glass**: not readable (not in `BREAK_GLASS_READABLE_TABLES`); portable read unaffected.

## Docs

No guide change: nothing a member or Workspace admin sees ships here (no console page, no
connection can be made yet). The Site settings API gains two fields without a console control;
the Site console field and all guide pages come with GIT-5 / GIT-13. Audit row updated by hand in
`docs/audit-log.md`.

## Open questions

- Which ticket adds the Site console controls for the switch and host list (GIT-5 covers only the
  Workspace console)? Suggest GIT-5.

## Evidence

- ac-1: `packages/db` `git.db.test.ts` (isolation, uniqueness, CHECKs, SET NULL keys, cross-team
  keys refused), `probe.db.test.ts`, `catalog.db.test.ts`, `drizzle-privileges.db.test.ts`,
  `migrate*.db.test.ts` green; `db:check` clean; `team-setters.test.ts` green.
- ac-2: `git/credential.test.ts` + `git.db.test.ts` "survives a rotation" (old key opens, rewrap
  to new key, new-only envelope opens); `sealed-keys.db.test.ts` names the family.
- ac-3: `git/site-settings.test.ts`, server `git-site-settings.db.test.ts` (API validation,
  403 for members, audit once per change, `decideGitHost` refusals), `authz/permissions.test.ts`.
