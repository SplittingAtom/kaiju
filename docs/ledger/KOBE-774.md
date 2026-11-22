# KOBE-774: Site setting "Require single sign-on" (SSO-only) with an owner break-glass path

- **Status:** in review (group 70)
- **Branch / worktree:** `group-70-hold-skills-sso-only` in `../Kobe-g70`
- **Depends on:** KOBE-626..634 (SSO), KOBE-755 (sign-in panel)

## Design

- **Storage:** `site_settings` key `require_sso` (no migration). `packages/db/src/sso-required.ts`
  holds the key, a transaction advisory lock (`kobe.sso.required`) and read/store helpers, shared
  by the server and the CLI.
- **Turning on** (`PUT /v1/site/sso/settings {requireSso: true}`, `site.users.manage`): only from
  a session signed in through a provider that is enabled now (`session_sso_contexts` joined to
  `sso_providers.enabled`). That is the "enabled and tested" proof: a real sign-in through the
  provider, by the admin who could otherwise lock themselves out. Refused with 409
  `sso_session_required`. The same transaction deletes every session without an SSO context
  (`identity.sso.required.enabled {sessionsEnded}`).
- **Turning off:** Owner only (as required 2FA: weakening every account), 403 otherwise;
  `identity.sso.required.disabled {reason: admin}`.
- **In force** = stored on AND `auth.sso.enabled` AND at least one provider can finish a sign-in
  (the sign-in page's list, which drops Helm providers without a mounted secret). So the chart
  kill switch, or a broken Helm secret, never locks the Site out.
- **Server enforcement** (Better Auth `before` hook, `auth.ts`): 403 `SSO_REQUIRED` on
  `/sign-in/email`, `/request-password-reset`, `/forget-password`, `/reset-password`,
  `/sign-up/email`, `/invitation/accept` (password sign-up), passkey
  `generate-authenticate-options`/`verify-authentication`. Passkeys are refused too: "require
  single sign-on" would be hollow otherwise (decision taken here; the ticket names passwords).
  `session.ts`: a session without an SSO context ends at its next check while in force. API keys
  and SCIM tokens are not Better Auth sessions: unaffected.
- **Lockout safety (a), break-glass:** `kobe sso allow-local-sign-in [--operator <name>]` in the
  operator CLI (`packages/cli`), with `KOBE_DB_MIGRATE_URL` (the owner role, as `kobe restore`):
  needs cluster access, never the web UI. One transaction: setting off + audit
  `identity.sso.required.disabled {reason: break_glass, operator}` (system actor; the hash chain
  verifies). Secondary path, documented: `auth.sso.enabled: false` also restores local sign-in
  (but switches SSO off for everyone).
- **Lockout safety (b), auto-off:** console disable/delete and the start-up Helm seed (provider
  disabled or dropped from values) call `releaseIfNoProvider` in the same transaction: setting off,
  `identity.sso.required.disabled {reason: last_provider, providerId, slug}` (system actor for the
  seed), then a best-effort email to every active site admin after the commit
  (`sso/required-notify.ts`). Advisory lock order makes concurrent disables and turn-on safe.
- **Sign-in page:** `GET /api/auth/sso/providers` gains `ssoRequired` (true only with a provider
  to offer); the server-rendered panel then shows only the provider buttons and "This site requires
  single sign-on" (no password, reset link, passkey).
- **Admin MCP:** not exposed: the site tools leave sign-in and two-factor settings to the console
  (`kobe-mcp/tools/site/settings.ts`, guide "Admin from a conversation").
- **OpenAPI:** `/v1/site/sso/settings` documented (`src/openapi/site-sso-settings.ts`) with a
  coverage test; the neighbouring provider routes are still undocumented (pre-existing).

## Review g70 fixes

- **H1 lockout:** turn-on also needs every active Owner to have an identity at an enabled provider
  (checked again under the lock in the turning-on transaction); refused 409 `owners_not_linked`
  with a count only. `GET /v1/site/sso/settings` returns `unlinked {owners, siteRoles, users}`;
  the confirmation says how many active accounts / site-role holders would be unable to sign in.
  Guide no longer points stranded admins to Expect SSO link (SSO10 forbids it for them).
- **M2:** disabling or deleting the last provider stays the safety valve (the one way an Admin ends
  the requirement); the `last_provider` event now names the acting admin (`byUserId`); guide says
  so.
- **L3:** `require_sso` and `require_2fa` are read as subqueries of the session check's account
  query (no extra round trip); the thread-read guard lets only `deps.sso.settings` through.
- **L4:** the invitation page (`components/auth/invite-form.tsx`) shows the provider buttons
  instead of the password form while the setting is in force; component test.
- **ac-6:** gate-sso stays a follow-up (below); the coordinator runs the browser spec on gate1.

## Second review: one invariant

"While Require single sign-on is stored on, every active Owner has an identity at an enabled
provider." Every write that could break it takes `lockSsoRequired` before changing anything and
calls `assertOwnerKeepsSignIn` after (throw → rollback → 409): turn-on; provider disable and delete
(`owner_would_lose_sign_in`; the last-provider auto-off still runs first, as the safety valve,
since disabling the last provider necessarily strands the Owner); ownership transfer
(`owner_not_linked`); unlink by the user or an admin (`last_sign_in_method`; while the setting is
stored on only another identity at an enabled provider counts, not a password or passkey). The
start-up Helm seed can't refuse, so it turns the setting off (`owner_unlinked`, system, email).
Race test: a provider disable blocked on the lock sees a turn-on that commits meanwhile and refuses.
Other writers checked: SCIM never deactivates or unlinks a site-role holder or the setup Owner
(`isProtected`, refused 403; the check runs before its transaction, a pre-existing narrow race
with an ownership transfer); provider issuer/tenant/subject can't change while identities are
linked (`identity_settings_locked`), so no reconfiguration deletes links; reactivation touches no
identities. The Owner can't be deactivated (`owner_cannot_be_deactivated`, site-users.ts).

## Third review: always an active Owner

- The invariant also fails for a deactivated Owner (`unlinkedOwners`).
- `deactivateUser` and reactivation take `lockSsoRequired` first (the lock ownership transfer takes),
  re-check under it that the target is not the Owner (SCIM: no site-role holder or setup Owner
  either; `DeactivationProtectedError` → admin 409 `owner_cannot_be_deactivated`, SCIM 403), and
  assert the invariant after. Unconditional: holds whether or not the setting is on.
- Ownership transfer refuses a deactivated target (409 `user_deactivated`), always.
- Reactivating the Owner is allowed (a site admin can undo a deactivated Owner).
- Race tests: SCIM DELETE vs transfer, admin deactivate vs transfer (the transfer commits while the
  deactivation waits on the lock; the deactivation then refuses).
- The `owner_unlinked` email and start-up log name their real reason.

## Docs

Guide: `admin/single-sign-on.md` (new "Requiring single sign-on" section, break-glass command,
break-glass account note), `getting-started/single-sign-on.md` (sign-in page in SSO-only mode,
linking needs an admin then), `reference/troubleshooting.md` (`SSO_REQUIRED`,
`sso_session_required`), `admin/site-admin.md`. Also `docs/install.md` (operator break-glass),
`docs/audit-log.md` (two events), `e2e/browser/README.md`, CLI usage text. For-agents pages list
no Site settings: unchanged.

## Follow-ups / left out

- **gate-sso** not extended: turning the setting on needs a site admin's SSO session through the
  mock Entra (an admin account linked to a mock identity), which the gate does not set up today;
  not a small addition. Covered instead by the server db tests and the browser spec.
- Browser spec `e2e/browser/tests/sign-in-sso-only.spec.ts` written, not run here (no deployment).
  It links the Owner (KOBE_USER) to the mock IdP once and ends the suite's stored session: run
  it on its own.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/sso-required.db.test.ts` "turning it on": refused from a local
  session (409) and with the session's provider disabled; on from an SSO session.
- ac-2: same file "while it is on": password sign-in, reset request/confirm, sign-up, invitation
  accept, passkey sign-in all 403 `SSO_REQUIRED`; local session ends at next check, SSO session
  kept; kill switch / unusable provider suspend it.
- ac-3: `apps/web/components/auth/sign-in-form.test.tsx` (KOBE-774 block),
  `lib/auth/sign-in-providers-server.test.ts`; browser spec.
- ac-4: `packages/cli/src/sso-break-glass.db.test.ts` (off + audit + chain verifies; no-op when
  off), `config.test.ts` (parsing); guide + install docs.
- ac-5: `sso-required.db.test.ts` "the last enabled provider going": disable, delete, Helm seed;
  audit + site admins emailed; stays on with another provider.
- ac-6: guide pages above; admin switch component tests in `site-sso-page.test.tsx`.
