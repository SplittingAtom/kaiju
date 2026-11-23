# KOBE-761: GIT-5: Git section in the Workspace admin console; members' read-only view

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-101-git-5-admin-console` in `../Kobe-g101`, stacked on
  `group-98-git-4-connection-routes` (KOBE-760)
- **Depends on:** spec `docs/specs/workspace-git.md` §3, §4, §7; KOBE-757..760 ledgers

## What ships

| Where                                         | What                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/admin/team/git` (`team.git.manage`)         | Connection cards (provider, host, organization, credential summary, level, health, last checked, expiry, capabilities, excess); Connect (3 steps); Settings; Replace credential; Check now; Disconnect |
| `/me/connectors` → **Git organizations**      | Members' read-only list (host, organization, level, health) from the member view of `GET /connections`                                                                                                 |
| Site console → Settings → **Git connections** | The Site switch and the allowed-host list (`PUT /v1/site/settings` `gitConnectionsEnabled`, `gitAllowedHosts`), checked with the server's rules first                                                  |
| Nav                                           | `lib/admin/nav/team/git.ts` (Workspace settings, order 45, READY)                                                                                                                                      |

Code: `apps/web/components/admin/team/git/*` (page, card, connect/settings/replace dialogs,
credential fields, permissions help, test report, member view), `components/admin/site/
git-site-form.tsx`, `lib/admin/api/team/git.ts` (typed from `@kobe/protocol` through a new
`Camelized<T>` in `lib/api/casing.ts`), `lib/admin/git/{labels,address,errors,host-forms}.ts`.

## Decisions

- **Secrets client-side:** token and private key are uncontrolled fields (password input; the
  key a textarea masked with `-webkit-text-security`, or loaded from a `.pem` file straight into
  that field). They never enter React state or props, so React never mirrors them into a `value`
  attribute; they are read only when Test / Connect / Test and replace is pressed, sent in the
  JSON body, wiped after success, and dropped when the dialog closes (its content unmounts). The
  Connect steps stay mounted (hidden) so the secret survives Back/Next without state. Field
  errors never repeat the value. App ID and installation ID are not secret (the admin view shows
  them) and are ordinary state.
- **Connect needs a passing test**; any edit drops the old result. The server tests again on
  create. A failing `credential_insufficient` shows its report.
- **Errors in Kobe's words** (`lib/admin/git/errors.ts`) by code and reason; the server's text is
  kept only where it carries the facts (version minimum, host not allowed, cap, duplicate).
  Health codes (`auth_failed:installation_removed`) become sentences; never shown raw.
- **Client change (minimal):** `lib/api/client.ts` lists `git_unavailable`, `host_unreachable`,
  `host_error`, `host_rate_limited` among the 5xx codes whose fixed text is shown, and keeps
  `details` for those codes when asked (`retry_at` of a rate limit). No server or protocol change.
- **Address and host-list checks** mirror `parseGitBaseUrl` / `parseDomainPattern` /
  `decideGitHost`; public suffixes are recognised by shape (no PSL in the browser), the server
  stays the authority. The Site settings route answers a bad list with a generic 400, so the form
  names each bad line itself.
- **Provider "icon":** lucide has no brand marks; a git icon plus the provider's name in text.
- **Not built here (later phases have no data yet):** §7's Repositories and Activity lists
  (GIT-6/7/9), the GitHub app-manifest pre-fill (G5 "can pre-fill": links to the host's form
  instead). Expiry notice in the bell stays KOBE-760's open question.
- **Wording:** "Workspace admin", "Site admin", "member"; GitHub's "installation" kept (identifier
  renamed to pass `check-site-wording`).

## Docs

New guide page `docs/guide/admin/git-organizations.md` (Team admin section): connecting each
provider with the exact permissions/scopes (KOBE-758/759 tables, incl. `write:issue`), access
levels, settings, replace, check, disconnect, expiry banner/email, members' view, Site switch and
host list. Rows/links added to `team-admin.md`, `site-admin.md` (Settings) and
`connectors-and-apps.md` (members' section). GIT-13 should re-check the page once agents' tools
and sandbox git land (it describes approvals and levels from spec G9/G12).

## Open questions

- The guide describes what agents can do per level (spec G9) before GIT-6/7 ship it; keep, or
  mark "coming" until then? (Left as the spec says; GIT-13 owns the final text.)
- Should the Site settings route name the bad host line (it validates with that message but
  answers a generic 400)? Small server change; not done here.

## Evidence

- ac-1: `components/admin/team-git-connect.test.tsx` — connect per provider and credential kind
  (GitHub App, fine-grained token, Enterprise Server base URL, Gitea, Forgejo), step checks
  (https, Site host list, organization, token shape, App ids, encrypted key), key from file,
  error mapping, cap refusal, replace (refused then accepted); `team-git-page.test.tsx` — states
  (loading/error/retry, empty, Site off with/without Site admin link, no envelope, cap of 5,
  expiring/expired banners, failing health, host no longer allowed, member without permission),
  Check now, Disconnect wording and cancel, Settings body and validation, members' view.
- ac-2: secret tests: password type, no `value` attribute, not in `innerHTML` or any field value
  after Connect / Replace / Cancel, only in request bodies (never URL or headers).
- ac-3: `site-git-settings.test.tsx`, `lib/admin/git/{address,errors}.test.ts`,
  `lib/api/client.test.ts`; browser spec `e2e/browser/tests/git-section.spec.ts` (self-contained
  with a `page.route` fake; a live Test runs only with `KOBE_GIT_*` set, else skipped; not run
  here: no deployment of this branch). Guide pages above.
- Green: web typecheck; `vitest run components/admin components/me lib/admin lib/api app`
  (132 files, 1213 tests) and `components/ui`; `@kobe/guide` tests; web `lib/docs`; server
  `kobe-mcp/docs`; e2e tsc; eslint + prettier on changed files; `check-site-wording`;
  `check-public-hygiene`.
