# KOBE-755: Restyle the sign-in page: themed, centred panel, email and password first, provider buttons below

- **Status:** in review (group 57)
- **Branch / worktree:** `group-57-signin-composer` in `../Kobe-g57`
- **Depends on:** KOBE-628 (provider buttons), KOBE-630 (SSO link confirm), KOBE-500/562 (branding)

## Plan

- `components/auth/auth-panel.tsx`: `AuthPanel` (logo, title as h1 naming the region, body,
  footer link) and `AuthDivider`. A full-screen layer (`fixed inset-0`, scrolls when tall) on
  `bg-console-panel`, the panel `max-w-[400px]` on `bg-console-bg`, centred with flex, `px-4`
  (16 px) gutter. Built from the console primitives (`Field`, `TextInput`, `Button`, `Notice`,
  `FOCUS_RING`): no new UI library, no CSS module, no global CSS change.
- `components/auth/sign-in-form.tsx`: the sign-in panel; `app/sign-in/page.tsx` is now a server
  component that reads the providers and renders it.
- `/forgot-password`, `/reset-password`, `/invite`, `/setup`, `/link-sign-in` (and
  `ConfirmSsoLink`) moved onto `AuthPanel` with the same controls.

## Decisions

- **Theme before sign-in:** nothing new was needed server-side. The root layout already fetches
  the Site branding for every request, signed in or not (`GET /v1/site/branding`: app name, show
  name, logo / dark logo / inline themed logo, favicon, theme preset or custom accent), renders the
  preset's tokens as a nonced `<style>` in the first HTML, and `app/theme.css` follows the
  `kobe-theme` cookie or, without one, the OS light/dark preference. Tailwind utilities reach the
  page through `chat-global.css` (loaded by `WorkspaceHost` on every page). So the first paint is
  themed: no flash. Logo: the shell's `<Brand />` (image, dark logo or themed inline SVG).
- **What a signed-out visitor gets from the server:** the branding above, and the public
  `GET /api/auth/sso/providers` (enabled providers' `slug` + `displayName`, ordered by display
  name, 404 while SSO is off). Passkey availability is not a server setting (Better Auth's
  passkey plugin is always on); the page shows the passkey button where the browser has WebAuthn.
- **No layout shift:** the providers are read in the server render
  (`lib/auth/sign-in-providers-server.ts`, 1 s timeout, kept 15 s per web process so sign-in
  traffic never meets Better Auth's per-address rate limit from the web pod's one address); the
  browser reads them only when that failed (null), as before. The passkey button renders on the
  server and first paint and is removed after hydration only where WebAuthn is missing.
- **SSO-only (ac-4): skipped.** There is no Site setting that disables password sign-in:
  `emailAndPassword.enabled` is hard-coded `true` in `services/server/src/auth/auth.ts`, and the
  SSO settings (`auth.sso.enabled`, providers) never turn local sign-in off. The only "SSO only"
  notion is per account (`SSO_ONLY_ACCOUNT`: an SSO-provisioned account has no local password),
  which the page cannot know before sign-in. Not invented; the admin guide says so.
- **Provider label** stays "Sign in with {display name}" (the configured name, e.g. "Sign in with
  Microsoft Entra ID"), the existing wording that specs and the guide use.
- **Order:** title, error alert (if any), email, password, Sign in, Forgot your password?, then the
  "or" divider and a group "Other ways to sign in" with the provider buttons (full width, server
  order) and Sign in with a passkey. No divider when the group would be empty. The TOTP step
  replaces the form inside the same panel and hides the alternatives.
- **Contrast and focus:** the panel uses only tokens the preset contrast floor test checks for all
  seven presets in light and dark (`lib/theme/presets.test.ts`: console fg/muted on console bg and
  panel 4.5:1, brand link 4.5:1, brand primary fg on primary 4.5:1, brand focus and control border
  3:1); the error Notice uses the fixed status colours. Focus rings are the console's
  `FOCUS_RING` (3 px brand-focus outline) on inputs, buttons, provider links and plain links.
- **Small wording additions:** "Back to sign in" footer on /forgot-password; a one-line hint on
  the TOTP step; the setup token's explanation is now the field's hint.
- Authentication logic is unchanged (same Better Auth calls, same pending-link redirect).

## Open questions (for Chris or the coordinator)

- Want a Site setting to turn password sign-in off (SSO-only)? It would be a server change
  (Better Auth `emailAndPassword` + a break-glass rule), not part of this ticket.

## Evidence (acceptance criteria → test or command output)

- ac-1: root layout (unchanged) + `AuthPanel` on console tokens; `auth-pages.test.tsx` (logo),
  browser spec `sign-in-page.spec.ts` (light/dark background from the preference, screenshots).
- ac-2: `auth-pages.test.tsx` (centring, 400 px, 16 px gutter); browser spec at 1280 and 360 px.
- ac-3: `sign-in-form.test.tsx` (no provider ± passkeys, one, several, order, autocomplete).
- ac-4: skipped, no such setting (see Decisions).
- ac-5: `sign-in-form.test.tsx` (TOTP step, wrong password, `?sso_error=`, pending link →
  /link-sign-in), `confirm-sso-link.test.tsx`, `auth-pages.test.tsx` (link page in the panel).
- ac-6: `auth-pages.test.tsx` (all five pages render in `[data-auth-panel]`).
- ac-7: component tests above + `lib/auth/sign-in-providers-server.test.ts`; browser spec
  `e2e/browser/tests/sign-in-page.spec.ts` (runs on the test install; not run here).
- ac-8: `docs/guide/getting-started.md`, `docs/guide/getting-started/single-sign-on.md`,
  `docs/guide/admin/single-sign-on.md`.
