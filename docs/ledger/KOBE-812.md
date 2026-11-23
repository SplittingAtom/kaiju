# KOBE-812: Per-account sign-in limit, and fail-safe reporting when the client IP is unknown

- **Status:** in review (group 90)
- **Branch / worktree:** `group-90-rl-account-delay` in `../Kobe-g90` (on `group-85-rate-limit-store`, PR #682)
- **Depends on:** KOBE-809 (`kobe_rate_limits`, `hitRateLimit`)

## Decided by the owner (2026-11-22), not re-opened

A growing delay, never a hard lockout. Failed password and second-factor attempts counted per
account across all IPs: 10 failures in 15 minutes, then 1 attempt per minute until the window
passes; cleared by a successful sign-in or a password reset; fixed in code. Site admins get an
audit event when an account enters throttling and a Site console notice; no email.

## Hook points (Better Auth 1.7.14)

A plugin, `signInThrottlePlugin` (`services/server/src/auth/sign-in-throttle-plugin.ts`),
registered after `twoFactor` and `ssoLinkPlugin` (their after hooks decide whether a sign-in
completed; the two-factor plugin nulls `newSession` while a code is outstanding) and before
`auditPlugin`. Global `hooks.before` (`authGuards`, e.g. SSO required) runs first, so a refused
request never reserves an attempt.

- **before** (`/sign-in/email`, `/two-factor/verify-totp|verify-backup-code|verify-otp` with or
  without a session, and signed-in password checks `/change-password`, `/two-factor/enable|disable|get-totp-uri|generate-backup-codes`):
  reserve one attempt for the account **atomically, before the secret is checked**
  (`countRateLimitHit`, one upsert). Up to 10 pass. Over 10, one attempt per minute passes (an
  atomic claim of a `sign-in-slot:` row, taken when the 10th failure lands so the 11th guess waits
  too; a refused attempt leaves the slot alone); the rest are answered 429 before Better Auth looks
  at the password.
- **after**: a wrong secret (`INVALID_EMAIL_OR_PASSWORD`, `INVALID_CODE`, `INVALID_BACKUP_CODE`,
  `OTP_HAS_EXPIRED`, `INVALID_PASSWORD`) keeps the reservation; any other outcome (correct password
  with 2FA pending, deactivated account with the right password, validation errors) refunds it,
  **including the minute's slot** (review M2: otherwise the code step after a correct password was
  refused until the next minute); a completed sign-in without a prior session (`newSession` on
  password, second-factor, invitation or SSO callback paths; the SSO callback's redirect is an
  `APIError` with status 302 and is treated as success, review L1), a password change and a
  password reset (`onPasswordReset` in `auth.ts`) clear the account. Code checks made from a session
  are counted but their success only refunds.
- Reserve-then-settle instead of check-then-count: with check-then-count a parallel burst would all
  pass the check before any failure was recorded (scrypt takes ~100 ms). Test: 40 parallel
  `begin()` calls let exactly 11 through.
- The second-factor user comes from Better Auth's signed `two_factor` cookie
  (verification row → user), the same key as the password, so password and code failures add up.

**Passkeys:** not counted (a WebAuthn assertion can't be guessed; failures are not evidence of
guessing) and never refused by the throttle: a throttled member can still sign in with a passkey.
A passkey sign-in does **not** clear the counter (review L2: a session holder can register a passkey
and sign in with it; the suggested "only passkeys registered before the window" rule only defers
that by one window, since a passkey registered now predates every later window). Still covered by
Better Auth's 100 per 10 s per IP.
**SSO:** not counted (the secret is at the identity provider, which limits it); a completed SSO
sign-in clears. **Password change:** counted (`INVALID_PASSWORD` from a signed-in session: a stolen
cookie guessing the password); success clears.

**Better Auth's own two-factor account lockout** (default on: 10 failed codes, then 15 minutes
refused even with the right code) is turned off (`accountLockout: { enabled: false }`): it is the
hard lockout the owner ruled out, and our counter covers codes. Its per-challenge try limit stays.

## Every endpoint that checks a password or second factor (Better Auth 1.7.14 + enabled plugins)

| Endpoint                                                        | Checks                           | Status                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in/email`                                                | password                         | counted (`INVALID_EMAIL_OR_PASSWORD`)                                                                                                                       |
| `/two-factor/verify-totp`                                       | TOTP                             | counted (`INVALID_CODE`), with or without a session                                                                                                         |
| `/two-factor/verify-backup-code`                                | backup code                      | counted (`INVALID_BACKUP_CODE`), test                                                                                                                       |
| `/two-factor/verify-otp`                                        | email OTP                        | counted; OTP is not configured (no `sendOTP`), answers `OTP_NOT_CONFIGURED`                                                                                 |
| `/change-password`                                              | password                         | counted (`INVALID_PASSWORD`)                                                                                                                                |
| `/two-factor/enable`, `/two-factor/disable`                     | password (`validatePassword`)    | counted (`INVALID_PASSWORD`)                                                                                                                                |
| `/two-factor/get-totp-uri`, `/two-factor/generate-backup-codes` | password (`checkPassword`)       | counted (`INVALID_PASSWORD`)                                                                                                                                |
| `/verify-password`                                              | password                         | **disabled** (`disabledPaths`, 404; only labelled server-scoped, answered over HTTP; nothing in apps/web, the CLI or server code calls it; review M1), test |
| `/delete-user`                                                  | password                         | **disabled** (`disabledPaths`; also off since `user.deleteUser` is not enabled), test                                                                       |
| `/reset-password`                                               | reset token (single use, 30 min) | not a password guess; Better Auth 5 per 60 s per IP                                                                                                         |
| `/passkey/verify-authentication`                                | WebAuthn signature               | not guessable; not counted                                                                                                                                  |
| `/sso/callback/:slug`                                           | IdP ID token                     | not counted; clears                                                                                                                                         |
| `view-backup-codes`, `generateTOTP`                             | —                                | server-only (`SERVER_ONLY`), not routed                                                                                                                     |

Not present: username, phone-number, magic-link and email-OTP sign-in; `/change-email` checks no
password. Kobe's own plugins (invitation, SSO, SSO link) verify no password.

## No enumeration

Every address, with or without an account, is counted under
`HMAC-SHA-256(auth secret, "kobe-sign-in-throttle\0" + email.toLowerCase())` (the normalization
Better Auth's `sign-in/email` uses). The request path does the same work for both: one reservation
upsert before, nothing after a failure (no refund); the throttled 429 is returned before any user
lookup. The only user lookup (email → id, for the audit event and notice) runs off the request path
(`background.run`) and only for failures at or over the threshold. The table holds no address:
keys `kobe:sign-in-fail:<hmac>`, `kobe:sign-in-slot:<hmac>`, `kobe:sign-in-throttled:<userId>`
(markers only for real accounts, read by the Site console). Test: known and unknown addresses give
identical statuses, bodies and retry headers through the 11th attempt, and no row key contains an address.

## Throttled answer

`429 {"message":"Too many requests. Please try again later."}` with `X-Retry-After` (as Better
Auth's own limiter) and `Retry-After` (seconds until the next allowed attempt or the window's end).
Web sign-in page: "Too many sign-in attempts. Wait a minute, then try again." for 429 on both the
password and the code step (also covers Better Auth's per-IP 429).

**Correct password while throttled:** refused until the next allowed attempt (otherwise the delay
is no delay). The allowed attempt then signs in and clears everything.

## Audit and Site console

`auth.sign_in.throttled` (`userId`, `until`; actor user null; request = the attempt that crossed)
once per window: the marker row is inserted with `ON CONFLICT … WHERE expires_at <= now RETURNING`,
so only the first throttling failure of a window writes the event (two replicas included). Nothing
for addresses without an account. Site console › Users shows a notice naming throttled accounts and
a **Sign-in slowed** badge, from new `GET /v1/site/users/sign-in-protection` (`site.users.manage`;
catalog + openapi.json updated, route inventory snapshot updated).

## Unknown client IP (ac-4) and SCIM (ac-5)

- Detected: plugin `onRequest` calls Better Auth's `getIP(request, options)` on every `/api/auth/*`
  request; `null` means its limiter is using the shared `no-trusted-ip|<path>` bucket. Reported:
  start-up warning when `KOBE_TRUSTED_PROXIES` is empty (`startup/server.ts`), a log warning once
  per replica and source on the first sighting, and a sighting row (`kobe:unknown-client-ip`, 24 h
  window, written at most once a minute per replica, no address) shown as a notice on Site console ›
  Users. Better Auth's shared-bucket behaviour itself is kept (it is the library's); the per-account
  throttle does not depend on the IP.
- `GET /v1/site/health` does not exist on this branch (KOBE-811 adds it): not created here; the
  notice sits on Users next to the throttled accounts. **Follow-up:** when KOBE-811 lands, also
  surface `clientIps.seen()` in Site health.
- SCIM failed authentications without a resolvable IP: counted per provider slug
  (`scim-auth-fail:no-ip:<slug>`, `-` for an invalid slug) instead of one `unknown` bucket, and
  reported the same way. A valid token never meets this limit, so the IdP's own traffic is never
  refused by it; an attacker can at most make other bad-token callers of that slug see 429 sooner.

## Concurrency

Every counter step is one atomic statement (upsert, conditional decrement, delete); every replica
shares `kobe_rate_limits`. Residual: an endpoint that throws a non-API error (500) skips the after
hooks, leaving one reservation unrefunded for that window.

## Residual risks

For the owner, plainly (security review 2026-11-22):

1. **Holding a victim at 1 attempt per minute is effectively a lockout of password sign-in while
   the attack lasts.** About 11 requests every 15 minutes, from anywhere, keep a known address out
   of password sign-in: the attacker takes each minute's slot as it opens and the victim's tries
   almost always meet a used slot. Passkeys and SSO still work; a reset clears it but the attacker
   refills it in seconds. A per-device exemption (a signed "known browser" cookie) would close it
   and needs a decision.
2. **With the library's 2FA lockout off, an attacker who knows the password gets roughly 2.4×
   more code guesses per day** (about 2,300 instead of about 960; about 0.7 % a day against a
   6-digit TOTP with ±1 step, against about 0.3 % before), and the fixed window allows about 20
   quick guesses across a window boundary.

- Changing an account's email moves it to a new counter (needs a signed-in session).
- Throttled (429) attempts are not audited individually (as with Better Auth's own 429s); the
  `auth.sign_in.throttled` event marks the window. The audit flood test now stays under the
  threshold (9 guesses per account).

## Docs

`docs/rate-limits.md` (new row, SCIM row, unknown-IP paragraph, gap 4 removed and the list
renumbered), `docs/audit-log.md` (`auth.sign_in.throttled`), `docs/guide/reference/troubleshooting.md`
(the sign-in message), `docs/guide/admin/site-admin.md` (Users: sign-in protection notices). No
"For agents" change: sandboxes never sign in.

## Checks

install, build; db/server/web typecheck; `src/sign-in-throttle.db.test.ts` (14, red without the
plugin: 6 fail; review round: +6 tests, 5 red before the fixes: `/verify-password`, slot refund
unit and full throttled password-then-code flow, passkey not clearing, SSO clearing in
`sso-sign-in.db.test.ts`; backup codes and the deactivated-account refund are coverage), `scim.db.test.ts` (new no-IP test), `auth`, `audit`, `account-lifecycle`,
`rate-limit`, `sso-sign-in`, `sso-required`, `sso-linking`, `audit-pii`, `invites`, `site-sso`,
`break-glass`, `offboarding`, `startup/server` db tests; server unit (`app`, `config`, `src/auth`);
`src/openapi` (regenerated), `route-inventory` (snapshot updated), `kobe-mcp/session-contract`;
web `sign-in-form`, `users-page` (new), `lib/admin/api/api`; `@kobe/guide` and `@kobe/db` audit
tests; eslint + prettier on changed files; site wording; public hygiene. Migration: none.
