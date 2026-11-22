# KOBE-785: Identity cleanup: throttle last_used_at writes, remove the dead JWT plugin, split createAuth/ssoPlugin

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group 75, branch `group-75-identity-scim-overage`)
- **Branch / worktree:** `group-75-identity-scim-overage` in `../Kobe-g75`
- **Depends on:** KOBE-775 (same branch), KOBE-774 (PR #672)

## Findings checked against this branch (review pass 2, Identity)

- **P2-18 held.** `authenticateScim` updated `scim_tokens.last_used_at` on every request.
- **P2-19 held.** Nothing outside tests called `/api/auth/token` or `/api/auth/jwks` (grep over
  apps, services, packages, e2e). `isProtected` / `isProtectedTarget` and `hasLocalCredential` /
  `hasLocalPassword` were the same queries; "end this provider's (and user's) SSO sessions" was
  written three times. `mfaProven` was used only by tests.
- **P2-20 held.** `createAuth` ~260 lines, `ssoPlugin` ~195 lines (callback ~90).
- **P2-17:** owner decision (Chris, 2026-11-22): keep as is. JIT keeps the address the provider
  sends, verified or not; no code change.

## Decisions

- **P2-18:** the token row is written only when `last_used_at` is null or older than a minute
  (`now()` on the database clock for both sides); when nothing is written the revocation is
  re-checked with a read, so a revocation committed after the candidate read still wins.
  "Last used" in the console is now accurate to a minute (no doc change: it shows a time, not a
  count).
- **P2-19:** Better Auth `jwt` plugin removed (and `jwks` from the adapter schema). The `jwks`
  table stays (dropping it needs a migration; it is already excluded from backups). New
  `sso/sso-sessions.ts`: `endSsoSessions(db, { providerId, userId? })` used by providers, linking
  and SCIM; `isProtectedUser` replaces both protected-user queries; SCIM uses
  `hasLocalPassword`. `mfaProven` removed (tests use `mfaEvidence`).
- **P2-20:** separate refactor commit, pure move (see the commit message for where each piece
  went); no behaviour change.

## Docs (docs/guide evaluation)

- P2-17: `admin/single-sign-on.md` "First sign-in" now says the account takes the address the
  provider sends, verified or not, the squatting trade-off, and to prefer providers that control
  their users' addresses (Entra: the sign-in name is used, not a self-set email).
- P2-18/19/20: nothing a member, admin or agent sees changes (the JWT endpoints had no consumer
  and were never documented); no guide change.

## Open questions (for Chris or the coordinator)

- Follow-up: a migration dropping the unused `jwks` table (left out here: no migrations in this
  group).

## Evidence (acceptance criteria → test or command output)

- ac-1: `scim.db.test.ts` "records a token's use at most once a minute" (row `xmin` unchanged on
  the second request; failed first); `auth.db.test.ts` "no JWTs" (`/api/auth/token` and
  `/api/auth/jwks` 404; failed first); identity db tests (scim, site-sso, sso-access,
  sso-linking, sso-required, sso-sign-in, auth, account-lifecycle) green before and after the
  refactor commit.
- ac-2: P2-17 decided by Chris (keep as is), recorded above, guide note added.
