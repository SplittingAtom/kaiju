# KOBE-758: GIT-2: Provider adapters: GitHub (App tokens and fine-grained tokens, github.com and Enterprise Server)

- **Status:** in review (group 96, branch `group-96-git-2-github-adapter`, not pushed)
- **Branch / worktree:** `group-96-git-2-github-adapter` in `../Kobe-g96`
- **Depends on:** spec `docs/specs/workspace-git.md` (G5, G6, §9). Parallel: GIT-1 (KOBE-757,
  tables), GIT-3 (KOBE-759, Gitea/Forgejo adapter, implements the same interface).

## What landed

A server-side library, no routes and no tables, under `services/server/src/git-hosts/`:

| File                                    | Role                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter.ts`                            | Provider-neutral interface `GitHostAdapter`, shared types, `GitHostError` (typed codes), `assertRepositoryName`. No GitHub specifics.                 |
| `http.ts`                               | Shared guarded client `hostRequest` + `GitHostNet` + `assertHostAllowed` (Site host limit). For GIT-3 too.                                            |
| `github/adapter.ts`                     | `createGitHubAdapter({ baseUrl, organization, credential, net })`.                                                                                    |
| `github/app-auth.ts`                    | App JWT (RS256, `node:crypto`), installation token minting per scope, in-memory `InstallationTokenCache`.                                             |
| `github/errors.ts`, `github/mapping.ts` | Status/headers to typed errors; URLs, JSON mapping, capability/excess analysis.                                                                       |
| `testing/git-host-contract.ts`          | `describeProviderContract(name, setup)` + `GitHostContractFake` + `contractNet()`: the suite GIT-3 runs against its own fake.                         |
| `testing/fake-github.ts`                | Fake GitHub Enterprise API (`/api/v3`): verifies App JWTs, issues tokens that carry and enforce their repositories and permissions.                   |
| `connectors/oauth/http.ts` (changed)    | `rawRequest` takes an optional `maxBytes` (default unchanged, 256 KiB); `RedirectRefusedError` carries the refused `Location` (never in the message). |

## Decisions

- **Outbound requests** reuse the connectors' SSRF guard (`checkConnectorUrl` + `rawRequest`, as
  SSO does since KOBE-626): https only (allowed ports), every resolved address public unless the
  Site lists it in its internal CIDRs, connection pinned to the checked address (rebinding),
  15 s deadline, 4 MiB answer cap (a page of 100 repositories is ~600 KB). Checked on every call.
  The policy refuses a `?query`, so origin + path are checked and the full URL is then sent on the
  pinned connection.
- **Redirects:** followed only for GET, on the API's own origin and under its path, at most 3 hops
  (GitHub answers a renamed repository with 301 to `/repositories/<id>`, G20). Anything else is
  `host_refused` (reason `redirect`).
- **Site host limit (G3):** `GitHostNet.allowedHosts` (lowercase host names); checked against the
  connection's base URL host before anything is sent. GIT-1/GIT-4 fill it from the Site setting.
- **Base URLs:** `github.com` (also `www.`/`api.`) → `https://api.github.com`; anything else is
  Enterprise Server at `<base>/api/v3` (a pasted trailing `/api/v3` is accepted).
- **Installation tokens (ac-1):** minted per use, narrowed to the one repository and the
  permissions that use needs (transport: `contents` read or write + `metadata`); never persisted.
  The in-memory cache is keyed by a SHA-256 of API root + whole credential (incl. private key) +
  scope, so another Workspace naming the same installation with a different key never gets a
  cached token. Reused while more than 5 minutes remain; concurrent callers share one mint; 500
  entries max. A cached token the host rejects (401) is dropped and the call retried once.
- **Installation ownership:** before the first token, the installation (`GET /app/installations/
<id>`, App JWT) must be on the connected organization, not suspended; remembered for an hour.
- **Capability probe (ac-2):** App: from the installation's permissions (create = administration
  write on an org; read = contents read; write = contents + pull_requests write; admin =
  organization_administration write); `excess` = every granted permission outside metadata,
  contents, pull_requests, issues, administration, as `name:level`. Fine-grained token: GitHub
  cannot report its permissions, so read is shown by listing and the rest is `unknown`; expiry from
  `github-authentication-token-expiration`. Classic token: `excess` carries `classic_token` and
  every scope beyond repo/read:org/read:user.
- **Errors:** `auth_failed` (reasons `credential_rejected`, `installation_removed`,
  `installation_suspended`, `installation_account_mismatch`, `invalid_private_key`), `not_found`
  (also a repository outside the organization), `forbidden` (`missingPermission` from
  `x-accepted-github-permissions`), `rate_limited` (`resetAt` from `x-ratelimit-reset`, or
  `retry-after`/60 s for secondary limits), `conflict`, `invalid_request`, `host_refused`,
  `host_unreachable`, `unsupported_host`, `unexpected`. Messages are fixed text; the logger has no
  field redaction (`log-safety.ts` keeps message/code/stack), so no error carries a token, key,
  URL query or body, and the adapter never logs.
- **Confinement:** every path is built from the validated organization and repository name;
  answers whose owner is not the organization read as `not_found`; a pull request `head` with
  `owner:` is refused (fork outside the organization). Public repositories are never created.

## Permissions the adapter needs (for the guide ticket, GIT-13 / GIT-5 console text)

**GitHub App** (repository permissions; no organization or account permissions):

| Permission     | Level          | Used for                                                                                                                                             |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata       | Read           | mandatory; repository reads, listing                                                                                                                 |
| Contents       | Read and write | clone/fetch (read), push (write, G11)                                                                                                                |
| Pull requests  | Read and write | open pull requests, comment on them                                                                                                                  |
| Issues         | Read and write | create issues, comment on issues                                                                                                                     |
| Administration | Read and write | only if agents may create repositories (GitHub requires it; it also allows deleting repositories, which Kobe never calls: the console should say so) |

Install it on the organization; "All repositories" when agents create repositories.

**Fine-grained personal access token:** resource owner = the organization (the org may have to
approve it); repository access all (or selected) repositories; repository permissions Metadata
read, Contents read and write, Pull requests read and write, Issues read and write,
Administration read and write only for repository creation. No organization permissions. Set an
expiry: the probe reads it. Actions appear as the token's owner (G6). A classic token works but is
flagged as excess.

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

No change in this ticket: nothing a member, admin or agent sees changes (library only, no route or
UI). The permission tables above feed GIT-5 (console text) and GIT-13 (guide).

## Open questions (for the coordinator)

- G9 read tools beyond the interface (list branches, read file, list/get pull requests and
  issues, create branch) and branch protection (G14) are not in the interface yet: GIT-6/GIT-10
  add methods to both adapters.
- Whether `administration:write` is shown as excess for a **Read**-level connection is GIT-4's
  call (it knows the access level); the adapter reports capabilities only.
- `empty` on GitHub is `size === 0` (GitHub has no flag); GIT-9 may want a commits probe.

## Evidence

- ac-1: `github/adapter.test.ts` "installation tokens (ac-1)": narrowing per use, cache until
  margin, concurrent mint, no cross-credential reuse, re-mint on a rejected token.
- ac-2: "capability probe (ac-2)": App permissions → capabilities + excess, read-only App,
  fine-grained owner/expiry, classic scopes.
- ac-3: contract suite run twice (fine-grained token, GitHub App) against the fake Enterprise
  Server (`/api/v3`), expired token (re-mint, 401), revoked/removed and suspended installation;
  SSRF (10.0.0.0/8, 192.168.0.0/16, the 169.254.169.254 metadata address, plain http, Site host limit, foreign redirect).
- `vitest run src/git-hosts`: 85 passed; oauth, sso and `kobe-mcp/session-contract` still pass.
