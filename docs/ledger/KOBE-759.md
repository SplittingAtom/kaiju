# KOBE-759: GIT-3: Provider adapter: Gitea and Forgejo (one adapter, version check)

- **Status:** in review (no PR yet; the coordinator lands it)
- **Branch / worktree:** `group-97-git-3-gitea-adapter` in `../Kobe-g97`, with
  `group-96-git-2-github-adapter` (KOBE-758) merged in
- **Depends on:** spec `docs/specs/workspace-git.md` (G3, G6, G7, G11, §9, GQ7); KOBE-758's
  shared interface. GIT-4 wires the adapter into routes.

## Deferred by the owner: in-cluster Forgejo for e2e (ac-3)

Chris, 2026-11-21: the in-cluster Forgejo service for e2e is **not** set up now ("we will set
this up later"). This ticket adds no Forgejo e2e service, chart component, CI job or licence
inventory row. ac-3 stays open until that later work; ac-1 and ac-2 are covered by unit and
contract tests against a local fake HTTP server.

## What landed

- `services/server/src/git-hosts/gitea/adapter.ts`: `createGiteaAdapter({ provider, baseUrl,
organization, token, net })` implements KOBE-758's `GitHostAdapter` (`git-hosts/adapter.ts`)
  over the shared `hostRequest` (`git-hosts/http.ts`).
- `gitea/version.ts` (minimums, one place), `gitea/errors.ts` (answers → `GitHostError`),
  `gitea/wire.ts` (zod-validated answers → shared shapes).
- Tests: `gitea/adapter.test.ts` runs KOBE-758's `describeProviderContract` against
  `testing/fake-gitea.ts` for Gitea and for Forgejo, plus Gitea/Forgejo specifics (version
  refusal, scopes, credential, sub-path install, size cap, timeout, pagination without `Link`).

## Changes to KOBE-758's shared code (reconciliation)

- `GitRepositoryCredential.narrowed?: boolean` added. The GitHub adapter sets `narrowed: true` for
  App installation tokens and `false` for fine-grained tokens (two one-line additions).
- `assertBranch`, `assertNumber`, `cursorPage` moved from `github/adapter.ts` to `adapter.ts`
  (unchanged; both adapters use them).
- Contract "pages through repositories" now follows `next` until the end instead of expecting
  exactly 100 items on the first page: Gitea caps pages at 50 by default (`MAX_RESPONSE_ITEMS`).
- `connectors/oauth/http.ts`: both branches added a body cap; kept KOBE-758's `init.maxBytes`.
- Version too old maps to the existing `unsupported_host` with `reason: "version_too_old"`
  (unreadable version: `reason: "version_unreadable"`); no new error kind.

## Decisions

- **Repository scope without per-repository tokens (G11, §9):** Gitea/Forgejo tokens cannot be
  narrowed, so `repositoryCredential` returns the connection's token (Basic user = the bot's
  login, password = the token) with `narrowed: false`, `expiresAt: null`. Before that it confirms
  on the host that the repository is in the organization and that the token's account has pull
  (read) or push (write) there. The egress proxy (GIT-7) must enforce the organization path and
  `git-upload-pack` vs `git-receive-pack`; the token's scope is the outer limit (§9).
- **Product detection:** `probe().provider` is the product the host identifies as (Forgejo
  reports `X+gitea-Y`), so the label is right even if the admin picked the other one;
  `adapter.provider` stays what the admin chose. GIT-4 decides whether to store the detected one.
- **Private networks, host limit, redirects:** as `hostRequest` does for every provider (address
  policy with the Site's internal targets, `allowedHosts` checked before each call, same-origin
  redirects only).
- **Version check:** read once per adapter instance; every other call is refused until it passes.
- **Capabilities (G4):** from `GET /users/{bot}/orgs/{org}/permissions` (the bot's role); excess
  named: organization owner, organization administration, site administration. Token scopes
  cannot be listed with a token, so a missing scope surfaces at first use as `forbidden` with
  `missingPermission` parsed from the host's 403 message.
- **Visibility:** neither product has internal repositories; `internal` is refused before
  sending (`invalid_request`), public always is (G10).
- **Drafts:** Gitea/Forgejo have no draft field on create; a draft gets the `WIP: ` title prefix
  (the default `WORK_IN_PROGRESS_PREFIXES`).
- **Logging:** the adapter never logs; errors carry fixed text (contract checks secrets).

## Minimum versions (constants in `src/git-hosts/gitea/version.ts`)

**Rule (Chris, 2026-11-22; for the guide ticket):** Kobe supports the release line current at
build time and one major back, **plus always the vendor's current long-term-support release**;
anything older is refused (`unsupported_host`, message names the minimum). Each minimum is the
older of "previous major .0" and "current LTS .0". Newer than current is accepted. Re-check at
every release of either product and move the constants. (This replaces my first reading of GQ7,
which refused Forgejo's LTS, and the coordinator's interim "oldest that works".)

Checked 2026-11-22:

| Product | Current           | Previous major | Current LTS                    | Minimum    | Confirmed                      |
| ------- | ----------------- | -------------- | ------------------------------ | ---------- | ------------------------------ |
| Gitea   | 1.27 (2026-07-13) | 1.26           | none (Gitea has no LTS line)   | **1.26.0** | partly: secondary sources only |
| Forgejo | 17.0 (2026-10-15) | 16.0           | 15.0 (supported to 2027-07-15) | **15.0.0** | yes: forgejo.org               |

Sources:

- Forgejo (official): release schedule https://forgejo.org/docs/latest/admin/release-schedule/,
  v17.0 announcement https://forgejo.org/2026-10-release-v17-0/, releases
  https://forgejo.org/releases/ (v16.0.5 listed), 15.x https://forgejo.org/releases/15.x/.
  The pages disagree on v16/v17 end-of-life dates by two weeks; that does not change the minimum.
- Gitea: the official 1.27.0 blog post was not found by search. 1.27.0 on 2026-07-13 rests on
  https://newreleases.io/project/github/go-gitea/gitea/release/v1.27.0,
  https://linuxiac.com/gitea-1-27-released-with-actions-improvements-and-45-cve-fixes/ and
  https://about.gitea.com/blog/gitea-cloud-release-1-27-1/; 1.26 on
  https://blog.gitea.com/release-of-1.26.0/. **Unconfirmed:** that no 1.28 has shipped by
  2026-11-22 (if it has, the minimum becomes 1.27.0). Check https://github.com/go-gitea/gitea/releases.

API check: every call and token-scope behaviour the adapter uses exists in both minimums (the
scoped-token model since Gitea 1.20, go-gitea PR #24767; Forgejo 15 reports `+gitea-1.22.0`).
Detection: `+gitea-` in `/api/v1/version` means Forgejo (all supported Forgejo releases have it).

## Token scopes (bot account token)

| Scope                | Why                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------- |
| `read:user`          | the bot's login (`/user`) for the probe and the transport credential                |
| `read:organization`  | read the organization, its repositories and the bot's permissions                   |
| `write:organization` | only if agents may create repositories (`POST /orgs/{org}/repos` needs both writes) |
| `write:repository`   | read/write repositories, push over smart-HTTP, open pull requests                   |
| `write:issue`        | create issues and comment (also on pull requests)                                   |

**Spec gap:** issues and comments need `write:issue`, which is missing from the spec's G7 list
(repository, organization, user). Gitea puts issues and comments under the issue scope. The docs
ticket (GIT-13) fixes the spec; GIT-5's console text needs it too.

## API differences between Gitea and Forgejo that mattered

- The version string (above) is the only difference the adapter reads.
- The 403 text for a missing scope differs by release: older `…required scope(s): [write:issue]`,
  newer `…required scope(s), required=[write:issue], token scope=…`; one pattern parses both.
- Everything else used is the same `/api/v1`; pagination is `page`/`limit` with `Link` and
  `X-Total-Count`, page size capped by the host (50 by default).

## Adapter security review fixes (2026-11-22, phase-1 branch)

- **M1, one Site matcher**: adapters take a `GitHostTarget` (`services/server/src/git-hosts/target.ts`)
  instead of a base URL; only `gitHostTarget(settings, baseUrl)` makes one (it calls
  `decideGitHost()`: switch, host patterns, https, no IP literal) and registers it in a private
  set, so a look-alike is refused (`no_site_decision`). `hostRequest(net, target, ...)` re-checks
  the request host and every redirect hop with the same decision (github.com pairs with
  api.github.com only). `GitHostNet.allowedHosts` and `assertHostAllowed` are gone. Callers build
  a fresh target per operation from `readGitSiteSettings()`. `decideGitHost` accepts http only
  with `allowHttp` (the connector policy's dev flag; the fakes now serve `http://git.fake.test`).
- **M2, host URLs**: `cloneUrl` is `cloneUrlFor(webBase, org, name)`, never the host's;
  `webUrl`/`html_url` pass `safeWebUrl()` (same origin and scheme as the base URL, under its path)
  or become "".
- **M3 (GitHub)**: a token on a user namespace must belong to that user (probe, listing, create,
  transport credential; `forbidden`/`token_owner_mismatch`); an App never creates in a user
  account; organizations use `/orgs/{org}/repos`.
- **Lows**: GitHub token `repositoryCredential` confirms the repository and pull/push first;
  `narrowed` is required; `missingPermission` is kept only when permission-shaped (`GitHostError`
  sanitizes it for every adapter); GitHub `resetAt` capped at a day; redirect edge cases tested
  (`git-hosts/http.test.ts`: cross-origin, scheme downgrade, port change, outside the API path,
  userinfo, POST/PATCH never followed, hop cap, credential never sent elsewhere).

## Guide

No guide change: a server-side library with no route, UI or agent-visible behaviour yet. GIT-5
(console) and GIT-13 (guide) document scopes and minimum versions from this ledger.

## Evidence

- ac-1: `pnpm --filter @kobe/server exec vitest run src/git-hosts` — the shared contract passes
  for Gitea, Forgejo and both GitHub credential kinds (195 tests in the two adapter files).
- ac-2: "refuses a version older than supported, naming the minimum, before any other call" (both
  products) + `judgeVersion` table; message e.g. "The git host runs Gitea 1.25.4; Kobe supports
  Gitea 1.26.0 and later."
- ac-3: deferred by the owner (above).
