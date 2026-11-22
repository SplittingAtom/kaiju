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

- **before** (`/sign-in/email`, `/two-factor/verify-totp|verify-backup-code|verify-otp` without a
  session, and signed-in password checks `/change-password`, `/two-factor/enable|disable|get-totp-uri|generate-backup-codes`):
  reserve one attempt for the account **atomically, before the secret is checked**
  (`countRateLimitHit`, one upsert). Up to 10 pass. Over 10, one attempt per minute passes (an
  atomic `sign-in-slot:` counter, seeded when the 10th failure lands so the 11th guess waits too);
  the rest are answered 429 before Better Auth looks at the password.
- **after**: a wrong secret (`INVALID_EMAIL_OR_PASSWORD`, `INVALID_CODE`, `INVALID_BACKUP_CODE`,
  `OTP_HAS_EXPIRED`, `INVALID_PASSWORD`) keeps the reservation; any other outcome (correct password
  with 2FA pending, deactivated account with the right password, validation errors) refunds it; a
  completed sign-in (`newSession` on a sign-in path, incl. passkey, invitation, SSO callback), a
  password change and a password reset (`onPasswordReset` in `auth.ts`) clear the account.
- Reserve-then-settle instead of check-then-count: with check-then-count a parallel burst would all
  pass the check before any failure was recorded (scrypt takes ~100 ms). Test: 40 parallel
  `begin()` calls let exactly 11 through.
- The second-factor user comes from Better Auth's signed `two_factor` cookie
  (verification row → user), the same key as the password, so password and code failures add up.

**Passkeys:** not counted (a WebAuthn assertion can't be guessed; failures are not evidence of
guessing) and never refused by the throttle: a throttled member can still sign in with a passkey,
which clears it. Still covered by Better Auth's 100 per 10 s per IP.
**SSO:** not counted (the secret is at the identity provider, which limits it); a completed SSO
sign-in clears. **Password change:** counted (`INVALID_PASSWORD` from a signed-in session: a stolen
cookie guessing the password); success clears.

**Better Auth's own two-factor account lockout** (default on: 10 failed codes, then 15 minutes
refused even with the right code) is turned off (`accountLockout: { enabled: false }`): it is the
hard lockout the owner ruled out, and our counter covers codes. Its per-challenge try limit stays.

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

- **Victim kept throttled.** An attacker who knows an address can make 10 failures every 15
  minutes from any IPs (Better Auth's per-IP limit is 3 per 10 s) and keep the account throttled,
  and can race the victim for the one attempt per minute. That is what the decision implies (a
  per-account delay with no per-IP exemption); the victim keeps passkeys, SSO and password reset
  (which clears it, though the attacker can start again), and Site admins see it in the audit log
  and on Users. A per-device exemption (e.g. a signed "known browser" cookie) would close it and
  needs a decision.
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
plugin: 6 fail), `scim.db.test.ts` (new no-IP test), `auth`, `audit`, `account-lifecycle`,
`rate-limit`, `sso-sign-in`, `sso-required`, `sso-linking`, `audit-pii`, `invites`, `site-sso`,
`break-glass`, `offboarding`, `startup/server` db tests; server unit (`app`, `config`, `src/auth`);
`src/openapi` (regenerated), `route-inventory` (snapshot updated), `kobe-mcp/session-contract`;
web `sign-in-form`, `users-page` (new), `lib/admin/api/api`; `@kobe/guide` and `@kobe/db` audit
tests; eslint + prettier on changed files; site wording; public hygiene. Migration: none.
