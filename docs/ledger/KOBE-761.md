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
- Access-level hints and the members' view describe fetch and push (GIT-7), not agent host tools
  (GIT-6, not built).
- **Wording:** "Workspace admin", "Site admin", "member"; GitHub's "installation" kept (identifier
  renamed to pass `check-site-wording`).

## Docs

New guide page `docs/guide/admin/git-organizations.md` (Team admin section): connecting each
provider with the exact permissions/scopes (KOBE-758/759 tables, incl. `write:issue`), access
levels, settings, replace, check, disconnect, expiry banner/email, members' view, Site switch and
host list. Rows/links added to `team-admin.md`, `site-admin.md` (Settings) and
`connectors-and-apps.md` (members' section). The tickets that build agents' git tools and sandbox
git extend the page.

## After GIT-4's review fixes (merged `group-98` at dcd983a63)

- Health `not_allowed` (Site switch off or host dropped from the list): its own badge "Not allowed
  by the Site" and a notice saying which and what to do (Site admin, or disconnect); not "Failing".
- `host_refused` / `not_reachable` (the uniform "cannot be reached or not allowed" answer) mapped
  in `lib/admin/git/errors.ts`, also as a stored health code.
- Private key over 8 KiB (requests are capped at 64 KiB) refused at once on paste or file, and at
  submit, with a clear message; nothing sent.
- Guide trimmed to what exists (coordinator): access levels described as a setting the test
  checks, plus one sentence that agent git tools and pushing arrive with later updates; no Repo or
  approval claims. The Site settings route's generic 400 for a bad host list stays (the form names
  the line).

## Phase-2 integration (merged GIT-7 `group-99` de7d9b645, GIT-8 `group-102` 15b7c4a17)

- Both merges were clean (no conflicts); `docs/audit-log.md` regenerated with the new event.
- **Commit author email (KOBE-764 ac-2):** `GET` / `PATCH /v1/team/git/settings`
  (`team.git.manage`, zod `gitTeamSettingsBodySchema`, answer `gitTeamSettingsSchema` in
  `@kobe/protocol` with the caller's `noreply_example`), stored in
  `teams.settings.git_commit_email` (KOBE-764's key and reader; team row locked), audited
  `git.settings.updated` `{setting, value, previous}` once per real change (event + `.doc.ts`
  row). OpenAPI catalog entries + details; route inventory regenerated. Not in the Kobe admin
  MCP: no tool, and `kobe-mcp-team.db.test.ts` already fails on any `team_git_*` tool beyond the
  connection list. DB test `git-settings.db.test.ts`: default + example, store/reader agreement,
  audit once with old/new, other settings kept, validation, member/contributor 403, Site admin
  without membership and another Workspace's admin refused, isolation. `GIT_COMMIT_EMAIL_MODES`
  now lives in the protocol (sandbox-git re-exports it).
- **Console:** "Commit author email" section on the Git page (two radios, one sentence each on
  what lands in history on the host, the admin's own no-reply example); component tests.
- **Access-level hints and guide** follow KOBE-763: any member at Read may fetch; push needs Read
  and write, Contributor or above and, on a Repo, editor/owner of its project; agent-limited
  connections are not usable by sandbox git; another organization refused; egress ceiling;
  renamed repositories not followed. Nothing about agent host tools beyond "later updates".
- **30 s:** disconnect and replace confirmations and the guide say sandboxes may keep access for
  up to 30 s (the proxy's credential cache). The proxy already drops entries on a change hint,
  but no route sends one yet (KOBE-763 "Left for other tickets"); not built here.
- **Rate limits:** `packages/db/src/rate-limit.ts` is not on this branch (PR #688), so the git
  routes keep the server's `hitRateLimit`.

## Phase-2 review fixes (review-g101)

- **M1:** "Allow commits straight to the default branch" is held back: removed from the Settings
  dialog and the guide (stored default `direct_commits = false` and the server field untouched).
  It governs Kobe's own commit dialog (G18/GQ11), not sandbox pushes; GIT-11 adds the control
  with its enforcement. The access-level hint and the guide now say a member who may push can
  push to any branch the host allows, so branches are protected on the host.
- **L1:** token and key fields: `autocomplete="new-password"`, `autoCapitalize="off"`,
  `spellCheck={false}`, `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`,
  `data-form-type="other"`.
- **L2 (intended):** after a failed Test, Connect or Replace the secret stays in its field so the
  admin can retry; it is wiped on success and dropped when the dialog closes (tested).
- **L3:** the masked key textarea relies on `-webkit-text-security` (Chromium, Safari, current
  Firefox); where unsupported the pasted key shows on screen only (not in state or attributes).
- **L4:** the Replace dialog's host links re-check the stored address with `checkBaseUrl`.
- **L6:** "git tools" removed from the Site form (not built); the Read hint and the members' view
  mention that connections limited to chosen agents are not usable by sandbox git.
- L5 (PSL private suffixes like `*.github.io` pass the form, server 400 is generic) left as known.

## Accessibility pass

Checked in component tests and by reading the markup: dialogs are Radix (focus trapped, Escape
and Cancel close, focus returns to the Connect button or the card button that opened them; tested
on Cancel); every control has a visible label (`Field`/`ChoiceGroup`, required marks, errors tied
by `aria-describedby` and announced with `role="alert"`); the three Connect steps are a form, so
Enter moves on, Back/Next/Test/Connect are buttons, and each step's heading takes focus (tested);
the step list marks `aria-current="step"`; test results, pending text and errors sit in a
`role="status"` live region; capabilities, health, level and expiry are words with icons
(`aria-hidden`), never colour alone; card buttons carry the connection name for screen readers;
the external host links say they open a new tab.

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
