# KOBE-775: SCIM groups overage removes IdP-given team memberships; OIDC freshness and session checks

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group 75, branch `group-75-identity-scim-overage`, on top of PR #672)
- **Branch / worktree:** `group-75-identity-scim-overage` in `../Kobe-g75`
- **Depends on:** KOBE-774 (PR #672: Require single sign-on, reworked `cookieSession`)

## Findings checked against this branch (review pass 2, Identity)

- **P2-1 held.** Nothing in production writes `scim_groups` / `scim_group_members` (only tests);
  `resolveSsoUser` fell back to SCIM memberships whenever the provider had any live SCIM token, so
  a linked user's overage applied an empty list and removed every `idp:<provider>` membership.
  Reproduced by the new db test (redirect `not_allowed` after the rows were removed).
- **P2-7 held.** `authorizationUrl` sent neither `max_age` nor `prompt=login`.
- **P2-14 held.** PR #672's `cookieSession` joins `sso_providers` but never read `enabled` or
  checked the link; `delegationBacking` had the same gap.
- **P2-15 held.** The second of two concurrent first sign-ins failed on `users_email_unique` →
  `email_taken` → `link_required`; the `raced` branch was unreachable.
- **P2-16 held.** `/^[0-9a-f-]{36}$/i` let `-`×36 and 36 hex digits through → `22P02` → 500.

## Decisions

- **Overage without SCIM group data: refuse, change nothing** (spec sso-oidc-scim §7: "otherwise
  it refuses the sign-in with `groups_overage`, and the console shows the fix"). SCIM groups count
  as provisioned for a provider only when it has at least one `scim_groups` row (a SCIM token alone
  is SCIM Users). With groups provisioned the spec's fallback (SCIM memberships) is kept. The
  refusal is audited by the callback as before (`auth.sign_in.failed`, reason `groups_overage`)
  and now also logged (`warn`, provider and user ids only). The admin is told on the **SSO access
  mappings** page (a note under each Groups provider) and in the guide. Keeping the memberships
  but letting the sign-in through was rejected: it would grant access on group data Kobe can't
  see (someone removed from the mapped group would keep it).
- **`max_age=600` for every provider** (from `AUTH_TIME_MAX_AGE_S`), Entra included: the rule is
  the same for all, and Entra only re-prompts a person whose Entra session is older than 10 min.
- **Session check** (`cookieSession`): an SSO session whose provider is off or whose identity link
  (provider, user) is gone is deleted and answers 401 (one extra `EXISTS` on the unique
  `(provider_id, user_id)` index, same round trip). The delegated path (`delegationBacking`) got
  the same two conditions, so an agent's admin tools follow the browser rule.
- Test fixtures that made SSO sessions without a link (`sso-required.db.test.ts` `ssoBrowser`,
  `kobe-mcp.db.test.ts`) now link the identity / enable the provider as a real sign-in would. Two
  `sso-required` expectations moved: a session at a disabled provider is now 401 (not 409), and
  the "delete the last provider" case is reachable only once nobody is linked (the console refuses
  `identities_linked` first), so it calls `deleteProvider` after removing the link.
- **P2-15:** `createJitUser` returns `conflict { emailTaken }`; on any conflict the link is
  re-read and the sign-in continues as linked, else `link_required` (address) / `token_invalid`.
- **P2-16:** strict 8-4-4-4-12 regex in both places (`readUser`, filter `id eq`).

## Docs (docs/guide evaluation)

- `admin/single-sign-on.md`: overage behaviour (refused, team access unchanged, audit reason, where
  the fix is shown, SCIM Users does not supply groups), `max_age` fresh sign-in, unlink ends an
  in-flight session too, SCIM section note.
- `reference/troubleshooting.md`: `groups_overage` (access unchanged; claim filter / app roles;
  SCIM does not help yet) and `token_invalid` (`max_age`).
- `docs/install.md` Entra step 7: access unchanged on overage.
- UI: note on **SSO access mappings** for Groups providers (`sso-mappings-page.tsx`).

## Open questions (for Chris or the coordinator)

- None. SCIM Groups (SSO-8, KOBE-632) remains parked; when it lands, its first group row turns the
  SCIM fallback on for that provider.

## Evidence (acceptance criteria → test or command output)

- ac-1: `sso-sign-in.db.test.ts` "KOBE-775: SCIM user provisioning without SCIM groups keeps the
  memberships and refuses" (failed before the fix with `not_allowed` and the row gone); the
  existing SCIM-memberships test still passes.
- ac-2: `sso-sign-in.db.test.ts` start-URL tests (`max_age=600`, Entra and generic), "a session
  made while its provider was turned off or unlinked" (2 tests), "a first sign-in racing another
  of the same identity continues as linked" (holds the other JIT transaction open, waits for the
  lock, commits); `scim.db.test.ts` "answers 404 in SCIM form for 36-character ids that are not
  UUIDs"; `kobe-mcp.db.test.ts` "SSO review A" (provider off / unlinked). Each failed first.
- ac-3: guide pages above; `apps/web` `sso-mappings.test.tsx` (note on Groups providers only).
- Files run: sso-sign-in, scim, sso-required, site-sso, kobe-mcp db tests; server `src/sso`,
  `src/auth`, e2e-sso-mock unit tests; web sso-mappings + lib/docs tests; lint, server + web
  typecheck, prettier.
