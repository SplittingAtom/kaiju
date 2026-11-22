# KOBE-759: GIT-3: Provider adapter: Gitea and Forgejo (one adapter, version check)

- **Status:** in review (no PR yet; the coordinator lands it)
- **Branch / worktree:** `group-97-git-3-gitea-adapter` in `../Kobe-g97`
- **Depends on:** spec `docs/specs/workspace-git.md` (G3, G6, G7, G11, §9, GQ7). Runs beside GIT-1
  (tables) and GIT-2 (GitHub adapter); GIT-4 wires the adapter into routes.

## Deferred by the owner: in-cluster Forgejo for e2e (ac-3)

Chris, 2026-11-21: the in-cluster Forgejo service for e2e is **not** set up now ("we will set
this up later"). This ticket adds no Forgejo e2e service, chart component, CI job or licence
inventory row. ac-3 stays open until that later work; ac-1 and ac-2 are covered by unit and
contract tests against a local fake HTTP server.

## What landed

- `services/server/src/git/provider.ts`: the provider-neutral interface `GitHostAdapter` (no
  Gitea specifics), its shapes, and `GitSecret` (a credential value that prints as `[redacted]`
  through JSON, `String()` and `util.inspect`).
- `services/server/src/git/provider-errors.ts`: `GitHostError` with codes `auth_failed`,
  `forbidden` (+ `missingScope`), `not_found`, `conflict`, `invalid_request`, `rate_limited`
  (+ `retryAfterSeconds`), `host_not_allowed`, `host_unreachable`, `version_unsupported`
  (+ version and minimum), `unexpected`. Fixed messages; never a URL, header, token or host text.
- `services/server/src/git/net.ts`: outbound JSON calls under the connectors' address policy
  (`checkConnectorUrl` + the pinned `rawRequest`), the Site host limit first, one deadline, 2 MiB
  answer cap, no redirects. `rawRequest` gained an optional `maxBodyBytes` (default unchanged).
- `services/server/src/git/gitea/{adapter,version,wire}.ts`: one adapter for both products.
- Tests: `src/testing/git-provider-contract.ts` (the reusable provider contract, 22 cases incl.
  error mapping, pagination, version too old, redirect and SSRF refusal, secret never leaking),
  `src/testing/fake-gitea.ts` (fake `/api/v1` for both products), `src/git/gitea/adapter.test.ts`
  (contract × Gitea and Forgejo + specifics).

## Decisions

- **Interface methods:** `probe`, `testConnection`, `getOrganization`, `listRepositories`
  (opaque cursor pages), `getRepository`, `createRepository`, `openPullRequest`, `comment`,
  `createIssue`, `transportCredential(repository, "read" | "write")`. Read tools for GIT-6
  (branches, files, list PRs/issues) are left for GIT-6 to add to the reconciled interface.
- **Repository scope without per-repository tokens (G11, §9):** Gitea/Forgejo tokens cannot be
  narrowed, so `transportCredential` returns the connection's token itself as
  `Authorization: Basic <bot login>:<token>` with `narrowed: false` and `expiresAt: null`; before
  that it confirms on the host that the repository is in the organization and that the token's
  account has pull (read) or push (write) there. The egress proxy (GIT-7) enforces the
  organization path and `git-upload-pack` vs `git-receive-pack`. The token's scope is the outer
  limit, as the console states (§9).
- **Private networks (G3, §9):** no special case. The adapter takes the caller's
  `ConnectorUrlPolicy`; a self-hosted host on a private address works only when its CIDR is in the
  Site's internal targets passed in that policy. Loopback, link-local and metadata are always
  refused. Redirects are refused outright (stricter than "no redirects to another host"; Gitea's
  API does not redirect except for renamed repositories, which G20 follows by id later).
- **Site host limit (G3):** a predicate `isHostAllowed(hostname)` on the net config, checked
  before any DNS or connection; GIT-1 owns the setting, GIT-4 passes it in.
- **Version check:** `/api/v1/version` is read once per adapter instance and every other call is
  refused (`version_unsupported`) when it is too old. Newer than tested is accepted with a note.
- **Abilities (G4):** from `GET /users/{bot}/orgs/{org}/permissions` (role in the organization);
  extra permissions named: organization owner, organization administration, site administration.
  Token scopes cannot be listed with a token on either product, so a missing scope surfaces at
  first use as `forbidden` with `missingScope` parsed from the host's message.
- **Credential expiry:** Gitea/Forgejo report none; `credentialExpiresAt: null`.
- **Visibility:** neither product has internal repositories; `internal` creates private (G10).
- **Logging:** the adapter never logs. `GitSecret` keeps the token out of accidental log lines;
  error messages and details never contain it (contract test checks message, JSON and stack).

## Minimum versions (GQ7: current at build time and one major back)

Checked 2026-11-22: Gitea's current line is **1.27** (Gitea numbers majors 1.x), Forgejo's is
**17.0** (15 October 2026). Minimums: **Gitea 1.26.0**, **Forgejo 16.0.0**. Constants in
`src/git/gitea/version.ts`; raise them when a new line is tested. Consequence worth knowing:
Forgejo's current LTS (v15) is refused under GQ7.

Detection: Forgejo reports `17.0.1+gitea-1.22.0` (its own version plus the Gitea API level);
Gitea reports `1.27.2` (dev builds `1.27.0+dev-…`). `+gitea-` means Forgejo. A product different
from the provider the admin chose is a note on the connection test, not a refusal.

## Token scopes (bot account token)

| Scope                | Why                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------- |
| `read:user`          | the bot's login (`/user`) for the test and the transport credential                 |
| `read:organization`  | read the organization, its repositories and the bot's permissions                   |
| `write:organization` | only if agents may create repositories (`POST /orgs/{org}/repos` needs both writes) |
| `write:repository`   | read/write repositories, push over smart-HTTP, open pull requests                   |
| `write:issue`        | create issues and comment (also on pull requests)                                   |

`write:issue` is not in the spec's G7 list (repository, organization, user); Gitea puts issues
and comments under the issue scope, so GIT-5's console text and GIT-13's guide need it.

## API differences between Gitea and Forgejo that mattered

- The version string (above) is the only difference the adapter reads.
- The 403 text for a missing scope differs by release: older `…required scope(s): [write:issue]`,
  newer `…required scope(s), required=[write:issue], token scope=…`; one pattern parses both.
- Everything used (`/version`, `/user`, `/orgs/{org}`, `/orgs/{org}/repos`,
  `/users/{u}/orgs/{org}/permissions`, `/repos/{o}/{r}`, `/pulls`, `/issues`, comments) is the
  same `/api/v1` on both; pagination is `page`/`limit` with `Link` and `X-Total-Count`.

## Guide

No guide change: this is a server-side library with no route, UI or agent-visible behaviour yet.
GIT-5 (console) and GIT-13 (guide) document scopes and minimum versions from this ledger.

## Evidence

- ac-1: `pnpm --filter @kobe/server exec vitest run src/git` — contract suite passes for Gitea and
  Forgejo (82 tests in the file).
- ac-2: contract case "refuses a version older than supported, with a clear message, before any
  other call" + `judgeVersion` table; message: "The git host runs version 1.25.4; Kobe supports
  1.26.0 and later."
- ac-3: deferred by the owner (above).
