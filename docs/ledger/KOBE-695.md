# KOBE-695: HSTS and global security headers on server responses

- **Status:** in review (group 49, branch `group-49-sec-app`)
- **Branch / worktree:** `group-49-sec-app` in `../Kobe-g49`
- **Depends on:** KOBE-690 (frame routes keep their own framing policy)

## Decisions

- Server: global middleware `services/server/src/security-headers.ts`, installed first in
  `createApp`. HSTS `max-age=31536000` when the public URL is https; `nosniff` and
  `X-Frame-Options: DENY` only when the route did not set them, so the frame routes (artifacts,
  workspace files, app frames, notebook output) keep `SAMEORIGIN`. Responses with immutable
  headers (redirects, relayed fetches) are copied.
- Web: `next.config.ts` headers are fixed at build time and one image serves http and https
  installs, so HSTS is set per request in `proxy.ts` (`hstsHeader(process.env)` from
  `KOBE_PUBLIC_URL`). Page responses carry it; that is enough for the browser to pin the host.
- `includeSubDomains`: chart `ingress.hsts.includeSubDomains` (default false, schema boolean) →
  `KOBE_HSTS_INCLUDE_SUBDOMAINS` on server and web. No preload.

## Docs

`docs/install.md`: an "HTTPS and HSTS" paragraph under Install and an upgrade note. No guide page
change: members and agents see no difference.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/security-headers.test.ts` (https / http), `app.test.ts`,
  `artifacts.db.test.ts` (http install: none); web `lib/security/csp.test.ts` (proxy, https/http).
- ac-2: `charts/kobe/tests/hsts.test.ts` (default off, on, non-boolean refused);
  `config.test.ts`; unit tests above.
- ac-3: `security-headers.test.ts`, `app.test.ts`, `artifacts.db.test.ts` (content route DENY),
  `workspace-frame.db.test.ts` (refusal DENY); frame DB tests still assert `SAMEORIGIN`.
- ac-4: frame browser specs (`app-frame.spec.ts`, `artifact-frame.spec.ts`) not run here (need a
  deployment); every frame route sets its own `X-Frame-Options`, which the middleware keeps.
