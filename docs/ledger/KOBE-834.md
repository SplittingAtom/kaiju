# KOBE-834: Email and notification subjects use the Site's app name

- **Status:** in review (stacked on KOBE-833, PR #735)
- **Branch / worktree:** `group-139-subject-app-name` in `../Kobe-g139`
- **Depends on:** KOBE-833 (base branch `group-138-rename-20-skills`)

## Plan

Grep every mail builder (`MailMessage`, `mailer.send`) and in-app notification title for a fixed
product name; route each through one reader and one header-safe cleaner.

## Decisions

- **One helper, `services/server/src/mail/app-name.ts`:** `mailAppName(raw)` cleans the name for
  headers (Cc/Cf/Zl/Zp to spaces, white space collapsed, cut at 40 code points without splitting a
  surrogate pair, empty → "Kaiju"); `readMailAppName(db)` reads it through the existing branding
  reader (`readAppName`, which already falls back on unset or invalid values); `appNameOnce(db)`
  shares one read across per-recipient background tasks.
- **Builders clean the name themselves**, so a caller cannot forget it; callers pass the raw name.
  The existing branded builders (`mail/messages.ts`, git conversion and expiry notices) switched
  from `oneLine(appName)` to `mailAppName(appName)`, which adds the empty-name fallback.
- **Read once per send:** outbox deliveries (egress requests, connector drift, team and Site
  break-glass) read lazily once per batch, only when something is due; retention's all-teams pass
  reads once and hands it to each team; team-member-added mails share one read (`appNameOnce`).
  The Default-skill notice reads once per team it emails (one per team step of the sync job).
- **Fixed prefixes replaced** (`Kaiju: …` → `<app>: …`): skills suspended after a scanner update,
  Default-skill added/removed, single sign-on no longer required, Registry review state, catalog
  skill withdrawn/revoked/restored, catalog skills unmaintained.
- **Bodies replaced** ("on Kaiju", "in Kaiju", "Kaiju shows/has/checks"): retention shortening,
  egress access requests, connector drift and skip notices, team and Site break-glass, skill
  install requests.
- **Already branded, untouched:** invitations, password reset, team member added, Site admin
  membership change, scheduled-run results and the notification digest, git conversion and
  token-expiry notices (KOBE-819). Budget alerts name no product.
- **In-app notification titles** (`apps/web/lib/notifications`) name no product: no change.
- **Not changed (auth library, static at startup):** better-auth `appName`, the TOTP `issuer` and
  the passkey `rpName` stay "Kaiju". The issuer and rpName do reach users (authenticator app label,
  passkey prompt) but are fixed when the auth instance is built and changing them per Site needs a
  restart-time value; out of scope here (see Open questions).
- **No email-verification or magic-link mails exist** (better-auth's are not enabled); SSO sends no
  mail of its own besides the require-SSO notice.

## Open questions (for Chris or the coordinator)

- Should the TOTP issuer and passkey RP name follow the app name too? They are fixed when the auth
  instance starts; a follow-up could read the chart default (`KAIJU_BRANDING_APP_NAME`) or the
  stored name at startup.

## Docs evaluation

Guide updated in this change: `docs/guide/appearance.md` (Site name also appears in the subject
and text of every email; unset it is "Kaiju") and `docs/guide/admin/site-admin.md` (Appearance
line). No "For agents" page covers branding or email; no UI label changed.

## Evidence (acceptance criteria → test or command output)

- **ac-1** subjects and bodies use the configured name, default when unset:
  `services/server/src/mail/app-name.test.ts` (every changed builder with "Acme": no "Kaiju" in
  subject or text; empty name → "Kaiju"; CR/LF/NEL/U+2028/bidi cannot break a header; 40-code-point
  cap) and `services/server/src/mail/app-name.db.test.ts` (unset → "Kaiju: …"; stored "Acme
  Analytics" → "Acme Analytics: …" for two senders; a stored CR/LF name falls back; one read).
- **ac-2** a site with a custom app name: the two test files above.
- e2e: no Mailpit/browser spec asserts subjects (`grep -rni subject e2e/`), so none changed.
- Checks green: build, typecheck, lint, server unit (4665), web unit (4384), server DB (3780),
  site wording, public hygiene, rename guard. format:check flags only the base branch's
  `docs/gates/gate-7b/extractor-memory-extractor-v3-glm-5.3-flash.json` (KOBE-833, 316ebf3d6).
