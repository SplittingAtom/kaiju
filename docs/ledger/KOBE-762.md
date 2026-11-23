# KOBE-762: GIT-6: Git host tools with policy defaults, approval cards and audit

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-103-git-6-host-tools` in `../Kobe-g103`, stacked on PR #692 (phase 2)
- **Depends on:** spec `docs/specs/workspace-git.md` §5 G9, G10, G12, G13, §8, §9; KOBE-757..764

## What ships

| Where                                         | What                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/server/src/git-hosts/` (adapters)   | `GitHostAdapter` gains `listBranches`, `readFile`, `listPullRequests`, `getPullRequest`, `listIssues`, `getIssue`, `createBranch` (GitHub + Gitea/Forgejo); one bounded mapper `reads.ts`; contract tests on both fakes |
| `services/server/src/git-tools/`              | catalog (14 `git_*` tools), access decision, executor, results (untrusted fences), errors, idempotency/audit ledger, approval card, sandbox guard, listing                                                              |
| Built-in Kobe connector (`kobe-mcp/`)         | git tools are pinned tools of the built-in connector: listed per sandbox, decided by `decideMcpCall`, executed by `runGitTool`                                                                                          |
| Policy                                        | git writes are `external` writes (ask in interactive runs); `git_create_branch` exempt (`policy/settings.ts`); not Kobe admin tools; reason `git_not_allowed`                                                           |
| `@kobe/protocol`                              | `gitApprovalSchema`, `approval.requested.git` (additive), reason code `git_not_allowed`                                                                                                                                 |
| `apps/web` `components/chat/git-approval.tsx` | card header: action, provider, host, organization, connection, repository, rows, posted text (plain, "Show all"), visibility                                                                                            |
| Audit (`packages/db` `events/git.ts`)         | `git.repository.created`, `git.branch.created`, `git.pull_request.opened`, `git.issue.created`, `git.comment.created`; Site audit view keys classified                                                                  |

Tools: reads `git_list_connections` (not in the spec's table: the agent needs the connection ids),
`git_list_repositories`, `git_get_repository`, `git_list_branches`, `git_read_file`,
`git_list_pull_requests`, `git_get_pull_request`, `git_list_issues`, `git_get_issue`; writes
`git_create_branch` (allowed), `git_create_repository`, `git_open_pull_request`, `git_comment`,
`git_create_issue` (ask, GQ3).

## Decisions

- **Mechanism** (superseded by M3 below: now the built-in git connector): the built-in Kobe connector, not a new gated frame. It is
  the existing pattern for server-run tools reached over MCP (KOBE-619): the MCP proxy routes it to
  the server, `decideMcpCall` runs the engine under every active run of the sandbox (KOBE-777/800),
  verifies and consumes the signed approval, writes `mcp.tool_call`; the sandbox's `policy.check`
  asks through the broker. No migration, no sandbox image or wire contract change. Consequence:
  the Site's Kobe MCP switch at **off** also removes the git tools (the connector is gone); at
  `docs` (default) or `admin` they are offered. Not tied to the agent's connector list (GQ8), but the
  agent's tool globs filter them.
- **Defaults through ordinary policy**: writes are open-world `external` writes, so interactive
  runs ask (risk class), `auto`/scheduled runs deny unless a Workspace allow rule lists them;
  `git_create_branch` is the one exemption (G9). Rules change both as for any tool. Spec G9's
  example "always allow opening pull requests in `acme/docs`" is a member's remembered approval
  (D29); a Workspace allow rule only allow-lists for unattended runs (D6). Open world: never in
  "Approve all waiting".
- **Access** (`git-tools/access.ts`), re-read at listing, sandbox `policy.check` (guard), proxy
  re-check (`refuse`) and in the executor before the host call: this Workspace's connection only
  (RLS; another Workspace's id is "not found"), not Off; writes need Read and write and
  Contributor+; a Repo needs editor/owner (`repoProjectRoles`/`repoRefusal` from GIT-7, after the
  host id is known); Site decision via `gitHostTarget()`; skill evals none. **Agent lists (GQ8):**
  usable only when every active run leased to the sandbox is a listed agent (the server cannot tell
  which run sent an MCP call). Reads may omit `connection` when exactly one is usable; writes must
  name it, so the connection is part of the signed input.
- **Canonical input covers the effect**: connection, repository, title, body, head, base, draft,
  number, `on`, name, from, description, visibility (default private, never the connection's
  default). Name prefix is checked, not added. The footer (G13) is added by the server from the
  run's member and thread and shown on the card exactly as posted.
- **Idempotency**: key = sha256(team, run, tool, canonical input)[:32] in the write's audit row (`callDigest`: the taxonomy forbids keys ending in "key");
  under the member's git write lock (`withAdvisoryLockRetry`) the executor looks for a row with
  that key from the last day before acting; a repeat answers `already_done` with the first result.
  Gap: if the host acted but the audit row failed (logged), a retry acts again.
- **Results**: host free text sanitised and fenced (`BEGIN/END UNTRUSTED GIT CONTENT`, nonce per
  answer); identifiers stripped of hidden characters; links as the adapters bound them; 64 KiB cap
  (`too_large`); file text cut at 48 KiB; error text fixed per code, host rate limit with
  `retry_at`. Never a credential.
- **Audit**: actor = member, `viaAgent` = run/thread/tool call, plus `agentId` of the named run,
  connection, host, organization, repository, host ids, number, link, `callDigest`. No titles,
  bodies or branch names (as `mcp.tool_call` records no input). Site view shows ids/number/link,
  hides `callDigest`.
- **Rate limits**: server `hitRateLimit` (durable `kobe_rate_limits`; the `@kobe/db` limiter of PR
  #688 is not on this branch): 300 reads / 10 min, 30 writes / hour per member per Workspace.
- **Repositories created by tools** get a `git_repositories` row (`origin = tool`).
- Footer name: the member's display name, never their email ("a Kobe member" when unset).

## Docs

`for-agents/working-with-git.md` (tools table, defaults, connection, approval, footer, retries,
untrusted fences, refusal codes), `admin/git-organizations.md` (agent column per access level,
"Agents' git host tools"), `connectors-and-apps.md` (members' section lists the tools),
`internet-and-approvals/approvals.md` ("Git changes" card), `docs/rate-limits.md` (three rows),
`docs/audit-log.md` regenerated.

## Left out

- Branch protection reads (G14) and the Git section's Repositories/Activity lists (GIT-10/GIT-13).
- No new route, so no OpenAPI entry.

## Security review fixes (review-g103, 2026-11-22)

- **M1**: `git.write.attempted` is committed under the member's git write lock before the host is
  asked to act; a repeat whose last record is an attempt answers `outcome_unknown` (check the
  host) and never acts; a certain refusal (`git.write.failed`, any host error but
  `host_unreachable`/`unexpected`) may be retried. Host values are sanitised/truncated
  (`safeHostId`, repository, number, https URL) so an odd value never drops the row. Audit events,
  no table.
- **M2**: per-connection budgets (the coordinator's numbers): 3,000 reads and 300 writes an hour
  per connection, all members together, in front of the adapter; `git_connection_budget` with the
  window end as retry time (member limits now report their window end too). Server
  `hitRateLimit` (no `@kobe/db` limiter on this branch).
- **M3** (owner decision): the git tools are the built-in **git** connector (`builtin = 'git'`,
  id `6b6f6265-0000-4000-8000-000000000002`, name `kobe-git`, seeded at start; migration
  `0250_git_builtin_connector` widens the two CHECKs), served by `/internal/v1/mcp/git/{list,calls}`
  (`git-tools/mcp-service.ts`, same `decideMcpCall` path) and routed by the MCP proxy. The Kobe
  MCP switch and the Kobe connector's thread toggle no longer reach them; the Git switch and
  connections are the ceiling. Conversation picker: its own always-on row (`builtin.kind = "git"`).
  Site settings hint, admin-from-a-conversation table, Site admin page say so. Policy: exemption and
  guard keyed on the git connector id; Kobe admin limits no longer count git calls. Agent tool
  editors list no git tools (globs still apply), unchanged.
- **M4** (owner decision): reading a Kobe Repo (matched by host id and last-seen name under any
  connection, `repoReadRules`/`repoReadable` in `git/transport.ts`) needs project `view`, in the
  tools (specific reads resolve the id first when the host has Repos; listings filter) and in the
  transport's fetch decision; refused exactly as missing. Reading a Repo follows the project's
  read rule; since KOBE-587 every Workspace member is an implicit reader of every project, so
  today this refuses no member — it takes effect wherever a project's readers are restricted. Tested with a stubbed permission (unit), fail-closed and allowed
  paths (DB, incl. rename and reconnect for transport).
- **Lows**: guide wording for create_branch in unattended runs (+ test); retries per run;
  `outcome_unknown`; file content verbatim inside the fence (`fenceGitFile`), metadata still
  sanitised; a public repository is reported as public, with a warning, and logged.
- Not done: L3 (footer name may change between card and post), L4 (names unfenced, bounded), L6
  (index for `callDigest`), L8 (file cap vs result cap).

## Round 2 lows (review g103, 2026-11-23)

- R2-L1: no capped list of Repo rules: `hostHasRepos` (EXISTS) decides whether to resolve, and
  `repoReadRules` is asked for exactly the requested repository (or the listed page) by host id
  or name, so any number of Repos fails closed (DB test with 5,002 Repos).
- R2-L2: write tools apply the read rule first; a Repo the member may not read looks missing.
- R2-L3: only a 4xx answer to the write itself is a certain refusal (`git.write.failed`); an error
  after a 2xx (e.g. an unexpected owner) leaves the attempt open, so a retry answers
  `outcome_unknown` and records never claim failure for a created repository (DB test).
- R2-L4: agents' refusal table lists `git_connection_budget` and `outcome_unknown`.

## Open questions (for the coordinator)

- Opus security review (ticket) not run here.

## Evidence

- ac-1: `git-tools/policy.test.ts` (defaults, rules, unattended, admin guard untouched);
  `git-tools.db.test.ts` unapproved write denied, tampered input refused, guard at `policy.check`.
- ac-2: `git-tools/access.test.ts`; `git-tools.db.test.ts` "refusals" (Read, reader, other
  Workspace, Site switch/host list, agent list, rate limits).
- ac-3: `git-tools.db.test.ts` GitHub fake, Gitea, Forgejo; footer names member and conversation;
  contract suite `git-hosts` for the new adapter methods (all four setups).
- ac-4: guide pages above.
