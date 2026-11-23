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

Set to the oldest release with every API call and token-scope behaviour the adapter uses
(coordinator, 2026-11-22, replacing my first "current and one major back" reading of GQ7, which
refused Forgejo's current LTS v15). Open for Chris: this is a looser reading of GQ7.

- **Gitea 1.20.0.** Rests on the token scope model: the scope names Kobe asks admins for
  (`read:user`, `read:organization`, `write:organization`, `write:repository`, `write:issue`) and
  the 403 naming the missing scope come from the scoped-token redesign, go-gitea PR #24767
  (merged 2023-06-04). _Assumed:_ that PR first shipped in 1.20.0 (its date fits the 1.20 cycle;
  not confirmed against release notes). Every endpoint is older: org permissions
  (`/users/{u}/orgs/{org}/permissions`, PR #17232, 2021, assumed 1.16), the others (`/version`,
  `/user`, `/orgs/{org}`, `/orgs/{org}/repos`, `/repositories/{id}`, `/repos/{o}/{r}`, pulls,
  issues, comments, `Link`/`X-Total-Count`) long before.
- **Forgejo 7.0.0.** The first release that identifies itself in `/api/v1/version`
  (`7.0.0+gitea-1.22.0`), on the Gitea 1.22 API, so above the Gitea minimum. Includes the current
  LTS (v15). _Assumed:_ Forgejo before 7.0 (1.20.x, 1.21.x) reports a Gitea-style version without
  `+gitea-`; it is then judged as Gitea of the same API level (accepted from 1.20, labelled Gitea).
  Both are long out of support.
- Raise a minimum only when the adapter starts using something newer.

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

## Guide

No guide change: a server-side library with no route, UI or agent-visible behaviour yet. GIT-5
(console) and GIT-13 (guide) document scopes and minimum versions from this ledger.

## Evidence

- ac-1: `pnpm --filter @kobe/server exec vitest run src/git-hosts` — the shared contract passes
  for Gitea, Forgejo and both GitHub credential kinds (195 tests in the two adapter files).
- ac-2: "refuses a version older than supported, naming the minimum, before any other call" (both
  products) + `judgeVersion` table; message e.g. "The git host runs Gitea 1.19.4; Kobe supports
  Gitea 1.20.0 and later."
- ac-3: deferred by the owner (above).
