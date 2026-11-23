# KOBE-763: GIT-7: Egress proxy: git smart-HTTP for connected organizations, per-repository credentials, read/write, limits

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-99-git-7-egress-git` in `../Kobe-g99`, stacked on PR #689 (phase 1)
- **Depends on:** spec `docs/specs/workspace-git.md` G8, G11, G12, §9; KOBE-757/758/759

## Request flow

1. Sandbox git sends a plain-HTTP proxy request `http://<host>/<org>/<repo>.git/…` with its
   `kobe.egress-proxy` token in `Proxy-Authorization` (remote rewriting is GIT-8).
2. `upgrade.ts` authenticates as today; `git/grammar.ts` classifies the raw target: canonical git
   smart-HTTP (3 endpoints, base path allowed), `invalid` (git-shaped but not canonical: 400), or
   `not_git` (ordinary egress, never a credential).
3. `git/handle.ts`: rate + concurrency limits, refuses a sandbox `Authorization`/`Cookie`, checks
   membership and the **site egress ceiling** (the Workspace's connection replaces the team's own
   enablement), then asks the server (`git/decisions.ts`, cached).
4. Server `POST /internal/v1/git/transport` (internal listener 8082, egress proxy's own key,
   sandbox token re-verified with liveness + membership; `routes/internal-git.ts`) →
   `git/transport.ts`: match connection by exact host + base path (https on 443) + organization
   (case-insensitive); G12 access; `gitHostTarget()` Site decision; open sealed credential; adapter
   `repositoryCredential(repo, read|write)` → `{username, password, expires_at, narrowed}`.
   `no_connection` → the proxy continues as ordinary egress (no credential).
5. Proxy resolves the host, checks addresses (internal only for an internal ceiling pattern),
   opens a fresh verified TLS connection per request, sends a path rebuilt from the server's base
   path + organization + validated repository, allow-listed headers, its own framing and
   `Authorization: Basic`, streams with back-pressure (`git/relay.ts`).

## Decisions

- **The proxy never unseals.** The server mints/opens per request and returns the credential on
  the internal listener only (same pattern as the MCP grant route). The proxy holds it in memory
  ≤ 30 s (less near expiry), keyed (team, user, sandbox, host, base path, org, repo, service),
  2,000 entries LRU; dropped at once when the host answers 401/407 and on any change hint. A
  removed connection or replaced credential is seen within 30 s. Server-side App tokens use the
  adapter's existing cache.
- **Separate internal key** (`<release>-egress-proxy-internal`), so neither proxy can call the
  other's routes; the internal listener still starts only with the MCP key (chart always sets both).
- **Read:** any active member at Read or above. **Write:** Read and write + Contributor+ + (Repo)
  editor/owner of its project (`projectPermissions().edit`). Schedules use the owner's sandbox.
- **Agent-limited connections (GQ8) are refused for transport** (`agents_restricted`): one sandbox
  serves all of a member's agents, so the transport cannot tell which agent asks. Fails closed.
- Skill-eval sandboxes get no git credential (`eval_sandbox`), like personal keys.
- **Redirects are never relayed** for git (502 with a message), not even same-host: simplest safe
  rule. If a host answers an old (renamed) repository URL with a redirect, git fails with that
  message and the remote must use the current name (open question below).
- Upstream 401/407 → 502 "refused the Workspace's git credential"; `WWW-Authenticate` never
  reaches the sandbox, so git never prompts for (or helpers never fill) a credential.
- **Audit in the egress audit (spec §8), written by the proxy** (it already writes audit rows):
  `egress.connection` gains `repository` + `gitService` (aggregated per repository/service) and
  git reasons; new `egress.git_push`, one row per push (allowed or refused) with up to 50 refs from
  the receive-pack command list (first 64 KiB, never the pack). Fetches only aggregated.
- Limits: push = connection's `push_limit_bytes` (declared length checked first, streamed bytes
  counted); fetch negotiation 64 MiB; responses 4 GiB; 30 min; per sandbox 8 concurrent, burst 60
  then 2/s (per replica, `docs/rate-limits.md`); server backstop 60 burst, 5/s per sandbox.
- A git relay lives until its own deadline (30 min), not the 15-minute egress token: a long push
  is not cut at token expiry. It is still closed when the member leaves or the ceiling drops the
  host (tunnel registry re-check, `git: true`).
- Chart: values `egressProxy.git.*` + schema, generated Secret, NetworkPolicy egress proxy → server
  8082 and the server admitting it there. Git hosts on private addresses use the existing
  internal-pattern / `allowedInternalCidrs` mechanisms (G3); no new rule needed.

## Threat model

| Boundary        | Attack                                                           | Mitigation                                                                                                                  | Test                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sandbox → proxy | read the credential from a response, header, redirect or error   | allow-listed response headers, secret-bearing ones dropped; 3xx/401 replaced; body scanned across chunks, exchange cut      | `git-proxy.test.ts` "adds the credential upstream only", "never follows or relays a redirect", "cuts a response that reflects the credential"; `wire.test.ts` |
| sandbox → proxy | bring its own credential (header, URL userinfo)                  | `Authorization`/`Cookie` refused (403), userinfo refused (403)                                                              | "refuses a request that brings its own credential", "refuses URL userinfo"                                                                                    |
| sandbox → proxy | point the credential at another org/repo/host via path tricks    | raw-target grammar: no `%`, `\`, `//`, dot segments, other queries, dumb protocol; upstream path rebuilt from server values | `grammar.test.ts`, "refuses non-canonical git paths outright"                                                                                                 |
| sandbox → proxy | other organization on the connected host                         | server `outside_organization` (403, message, audited push)                                                                  | "refuses another organization…"; `git-transport.db.test.ts`                                                                                                   |
| sandbox → proxy | API / web paths on the host with the credential                  | non-git paths never asked about, ordinary egress                                                                            | "gives a host without a connection, and API paths… no credential"                                                                                             |
| sandbox → proxy | push without write rights                                        | server decides (level, role, Repo project role); proxy enforces per service                                                 | "enforces read vs write…"; db test "contributor push", "Repo", "read_only"                                                                                    |
| HTTP parsing    | CL+TE, duplicate CL, pipelined second request reusing the header | llhttp strict parsing (400); one upstream TLS connection per request, `Connection: close`, no agent                         | "rejects ambiguous framing", "does not carry the credential into a pipelined second request"                                                                  |
| HTTP parsing    | h2c upgrade / hop-by-hop / `Expect` smuggling                    | request header allow-list; HTTP/1.1 only, ALPN http/1.1 upstream                                                            | "drops h2c upgrade attempts…", push test with `Expect: 100-continue`                                                                                          |
| proxy → host    | DNS rebinding / internal targets                                 | resolve once, address policy, connect to the checked address, TLS verified for the host                                     | "refuses an internal address unless the ceiling pattern is internal"                                                                                          |
| proxy → server  | another pod asks for credentials                                 | NetworkPolicy (egress proxy only), own key, sandbox token re-verified (audience, liveness, membership)                      | db test "authenticates the proxy… and the sandbox"; chart test "lets the egress proxy reach the server's internal port"                                       |
| server          | credential in logs/audit                                         | logs carry decision metadata only; audit rows carry no credential                                                           | db test "never logs the credential"; `connection-audit.test.ts`; real-git test                                                                                |
| resources       | huge packs, floods                                               | streaming with back-pressure, size/time limits, rate + concurrency                                                          | "enforces the push limit", "caps clone responses", "applies the per-sandbox git rate limit"                                                                   |

## For GIT-13 (guide pages) — what they must say

- Workspace admin (Git section): pushes need Read and write + Contributor (+ editor on a Repo);
  connections limited to chosen agents cannot be used by git in the sandbox; the push limit;
  the host must be in the site egress ceiling (private hosts: internal pattern); redirects
  (renamed repositories) are not followed: use the current name.
- For agents (working in a sandbox): use `http://<host>/<org>/<repo>.git` remotes (GIT-8 sets
  this up), never add credentials; the error texts (`outside the organization`, `read-only`,
  `Contributor role`, `editor or owner`, `too many git requests`, `limited to N bytes`).
- Members' connectors page: which organizations their sandbox can clone/push.
- Audit: `egress.git_push` and the git fields of `egress.connection`.

## Left for other tickets

- GIT-8: sandbox git config (`url.<http://host/org/>.insteadOf`, `http.proxy`, no helper),
  authorship. GIT-9/10/11: conversion, mirror, commit flow. GIT-4: connection routes (no change
  hint is sent yet; the 30 s TTL bounds staleness). e2e from inside a real sandbox (ac-3) and the
  Forgejo/GitHub gate runs (ac-1) need GIT-8 and the deferred in-cluster Forgejo.

## Open questions

- GQ8 agent lists vs transport: refuse (current) or allow when any running run of the member uses
  a listed agent? The latter needs run identity in the egress token.
- Renamed repositories: if a host redirects old smart-HTTP URLs, should the proxy follow a
  same-host redirect after re-asking the server for the new path? Not built (refused today).
- Reads of a Repo: every member reads (RV1 implicit readers); confirm no stricter rule wanted.

## Evidence

- ac-1 (fakes): `services/egress-proxy/src/git/real-git.test.ts` runs real `git` 2.47 clone,
  push (new branch), fetch through the proxy to `git http-backend` behind TLS that accepts only
  the Workspace credential; sub-path base (Forgejo/Gitea) in `git-proxy.test.ts`.
- ac-2: outside org / Read / reader / project reader / other host: `git-proxy.test.ts`,
  `git-transport.db.test.ts`, real-git "refuses a push outside the organization".
- ac-3 (proxy side): no credential in the clone's config, responses, audit, logs; `git credential
fill` gets nothing. In-sandbox e2e waits for GIT-8.
- ac-4: push limit tests; `egress.git_push` rows with refs (`git-proxy.test.ts`, real-git,
  `connection-audit.test.ts`).
- Checks: egress-proxy unit 161 + db 8; server `git-transport.db.test.ts` 10, `git/transport.test.ts`,
  config, routes, route-inventory, openapi, session-contract; db audit 837 + team-setters; chart
  392 + helm lint; eslint, prettier, site wording, public hygiene.

## Docs

No guide change in this ticket (GIT-13 writes the pages, list above): nothing is visible until
GIT-8 configures sandbox git. Operator docs updated: `docs/install.md` (Git for connected
organizations, upgrade note), `docs/backup-restore.md` (new Secret), `docs/rate-limits.md`,
`docs/audit-log.md` (generated).
