# KOBE-760: GIT-4: Connection routes: create with test, update, replace credential, remove; health and token-expiry notices

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-98-git-4-connection-routes` in `../Kobe-g98`, stacked on PR #689
  (phase 1: KOBE-757/758/759)
- **Depends on:** spec `docs/specs/workspace-git.md` (§3, §4 G6, G8, §7, §8)

## What ships

| Route (`/v1/team/git`)                  | Who                                                                   | What                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /connections`, `/connections/{id}` | every member (`team.read`): member view; Workspace admins: admin view | §7: members see what their agents can reach; admins also get the Site's host list            |
| `POST /connections/test`                | `team.git.manage`                                                     | test without saving (G4); `test.ok` false names what is missing                              |
| `POST /connections`                     | `team.git.manage`                                                     | Site decision, precheck, probe, judge, seal, insert under the cap lock (201)                 |
| `PATCH /connections/{id}`               | `team.git.manage`                                                     | settings only: display name, access level, repo defaults, push limit, direct commits, agents |
| `PUT /connections/{id}/credential`      | `team.git.manage`                                                     | re-probe, re-seal (same connection id), old ciphertext overwritten, cached tokens dropped    |
| `POST /connections/{id}/check`          | `team.git.manage`                                                     | Check now: stores health, 200 with `test` or `error`; 403 when the Site refuses              |
| `DELETE /connections/{id}`              | `team.git.manage`                                                     | deletes row + credential; `git_repositories` rows stay, `host_state = unreachable` (G20)     |

Code: `services/server/src/routes/team-git.ts`; work in `services/server/src/git/`
(`connections.ts` orchestration, `connection-store.ts` short `withTeam()` writes,
`connection-test.ts` judging + failure mapping, `connection-schemas.ts` zod bodies,
`connection-view.ts`, `adapters.ts`, `health-job.ts`, `expiry-notify.ts`). Answers are typed by
`@kobe/protocol` `git-connections.ts` (for GIT-5). A Site admin who is not a member gets the
usual 403/409 from `requireTeam`; another Workspace's ids are 404.

## Decisions

- **Reads:** members get `{id, provider, base_url, organization, display_name, access_level,
status}`; admins the record minus the sealed credential and key id (both views from
  `readGitConnection(s)`). The admin MCP gets one read tool, `team_git_connections_list`
  (`team.git.manage`), without even the masked hint; no write tool (§7, console-only like headers).
- **Cap and uniqueness (G2):** a cheap precheck before probing, then the insert takes
  `pg_advisory_xact_lock('kobe.git_connections:<team>')`, counts and checks the pair again in the
  same transaction; the unique index is the backstop (`already_connected`). Test: 3 seeded rows +
  3 concurrent connects → exactly 201, 201, 409 `connection_limit`.
- **Judging a test (G4):** refused (`credential_insufficient`, 422, with the report) when read is
  `no`, or write is `no` at Read and write. Warnings: the adapter's `excess`; `more_than_level`
  when write/create is `yes` below Read and write (answers KOBE-758's open question on
  `administration:write` at Read); `unverified` for `unknown` capabilities (fine-grained tokens).
- **Detected provider (G7):** a Forgejo picked as Gitea (or the reverse) is stored as what the host
  reports; the organization is stored in the host's spelling when it matches case-insensitively.
- **https only:** new connections are decided without the connector policy's dev `allowHttp`
  (the table CHECK stores https only; G11 forwards over verified HTTPS). Tests reach the fakes
  through a new deps seam, `ServerDepsOptions.gitHostRequest` → `deps.gitHostNet.request`
  (the adapters' own "tests answer here" hook), which sends the checked https URL to the fake's
  HTTP port.
- **Failure mapping:** Site refusals 403 `git_disabled` / `host_not_allowed`; 422
  `credential_rejected`, `credential_forbidden`, `organization_not_found`, `unsupported_host`,
  `host_refused`, `invalid_base_url`, `invalid_connection`; 502 `host_unreachable` / `host_error`;
  503 `host_rate_limited`. Messages are the adapters' fixed text; `test` carries code, reason,
  `missing_permission`, `retry_at`. Health stores `code[:reason]` (≤64), never host prose.
- **Token cache:** `InstallationTokenCache` now groups keys per credential
  (`credentialGroupKey`); replace and remove call `forgetGitCredential` after commit. Other
  replicas never reuse a removed credential's tokens (every use reads the row first); theirs
  lapse within the hour.
- **Health job** (`git-health` in `startup/jobs.ts`, lock `kobe.git-health`): every 15 min,
  probes connections (not at Off) unchecked for 6 h, 4 at once, one per host; a host failing with
  `host_unreachable` / `rate_limited` / `unexpected` / `conflict` backs off 15 min doubling to 6 h
  (or its reset time). Teams listed with `scanTeams()` (reads only); credential read and health
  write are separate `withTeam()` transactions; no transaction spans a host call. A write is
  dropped if the credential changed meanwhile (`credential_updated_at` match). Site switch off or
  no envelope: no probes.
- **Expiry notices (G6):** email to active Workspace admins when the host-reported expiry is
  within 14 days (or past), once per credential (`expiry_notified_at`, reset on replace). Claim +
  audit `git.connection.expiry_notified` commit before sending; a failed send is logged, not
  retried. No bell notification: a new kind needs `NOTIFICATION_KINDS` (protocol), the
  `notifications_kind` CHECK (migration) and web rendering, and the connection name has no column
  there; left as a follow-up. The admin view has `credential.expires_soon` for the console.
- **Audit** (new area `packages/db/src/audit/events/git.ts` + `.doc.ts`, table regenerated):
  `git.connection.created|updated|credential_replaced|removed|test_failed|expiry_notified`; ids,
  provider, host name, organization, codes; `test_failed.failure` (the field `code` is forbidden by
  the taxonomy test). New audit category `git` added to the web Site audit filter list (its drift
  test requires it).
- **Rate limit:** one per-member bucket `git-host-calls:<user>`, 30 per 10 min, for test, create,
  replace and check, with the server's `hitRateLimit` (the `@kobe/db` limiter of PR #688 is not on
  this branch; switch when it lands). Rows in `docs/rate-limits.md` (also the health job's caps).
- **Legal hold / erase / backup:** nothing new: the tables hold no member content (KOBE-757
  ledger); disconnect touches nothing on the host (§9).

## Review fixes (2026-11-22, review-g98)

- M1: Git row for `team_git_connections_list` in `docs/guide/admin/admin-from-a-conversation.md`
  (the For agents pages name admin tools only generically).
- L1: back-off for `rate_limited` / `unexpected` / `conflict` is per connection; only
  `host_unreachable` backs off the host.
- L2: with no Site host list, an unreachable or unresolvable host and an address the policy
  refuses all answer 422 `host_refused` / reason `not_reachable` (also in audit and health); the
  detail goes to the server log only.
- L3: health status `not_allowed` (protocol enum) when the Site turned Git off or dropped the host:
  decided before any credential is opened or call made, stored as `host_refused:site_*`, re-decided
  every pass so it clears soon after the Site allows the host again.
- L4: the health pass reads Site settings before each check.
- L5: `bodyLimit` 64 KiB on `/v1/team/git/*` (413 `too_large`).
- L6: noted (token-cache forgetting stays best effort, per process).

## For GIT-5 (KOBE-761)

- Shapes: `@kobe/protocol` `gitConnectionListSchema`, `gitConnectionAdminViewSchema`,
  `gitConnectionMemberViewSchema`, `gitTestReportSchema`, `gitTestErrorSchema`,
  `gitConnectionSavedSchema`, `gitConnectionCheckedSchema`, `gitConnectionRemovedSchema`.
  Request bodies: `services/server/src/git/connection-schemas.ts` (snake_case; credential
  `{kind:"access_token", token}` or `{kind:"github_app", app_id, installation_id, private_key}`).
- The list answer has `site` (`enabled`, admins also `allowed_hosts`), `limit` (5) and
  `envelope_configured` (false → every write is 503 `git_unavailable`).
- Expiry emails link to `/admin/team/git` (`CONSOLE_PATHS.teamGit`): the page must live there.
- Members' read-only view (connectors page) uses the same `GET /connections` (member view).
- Site console controls for the switch and host list: still unassigned (KOBE-757 suggests GIT-5).

## For GIT-13 (guide) — what an admin can already see via the API

All routes above (OpenAPI catalog, Team tag); the admin MCP tool `team_git_connections_list`;
the expiry email; the six audit events; the 30-per-10-min limit; https-only base URLs; at most 5
connections, one per host and organization; a Forgejo/Gitea label follows the host. No guide page
changes here: no console UI ships until GIT-5 and GIT-13 owns the pages (brief).

## Open questions

- Bell notification for token expiry (protocol + migration + web) as its own ticket?
- Should a connection that starts failing (`auth_failed`, installation removed) also email admins?
  Today it only shows in health.

## Evidence

- ac-1: `team-git.db.test.ts` "tests without saving; refuses a failing credential and says what it
  may do", "tests, then stores a sealed credential and answers what it may do", GitHub App connect.
- ac-2: `team-git.db.test.ts` "credential material never leaves the server" (every answer, audit
  row, email and log line of the file checked for the token, PAT, private key, sealed texts and key
  ids); validation refusals never echo; `kobe-mcp-team.db.test.ts` "git connections: reads only".
- ac-3: cap race, `already_connected`, Site switch / host list refusals (create, test, check),
  health job (failure codes, back-off, deferral), expiry email once + audit.
- ac-4: catalog entries + details (`openapi/catalog/details/team-git.ts`); `vitest run src/openapi`
  green; route-inventory snapshot regenerated.
- Also green: `src/git`, `src/git-hosts`, `src/kobe-mcp` (incl. session-contract, team-tools),
  `src/startup`, `startup-seeds.db`, `git-site-settings.db`, `kobe-mcp-team.db`; `@kobe/db`
  `src/audit`, `src/git`, `team-setters.test.ts`; web `audit-categories.test.ts`; site wording and
  public hygiene checks; eslint + prettier on changed files.
