# KOBE-767: GIT-11: Committing to a Repo from Kobe's commit flow (branch and pull request, conflicts); Repo mounts as a git working copy

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-108-git-11-commit-flow` in `../Kobe-g108` (from main `c02febd54`)
- **Depends on:** spec `docs/specs/workspace-git.md` G12, G13, G18, G19, GQ10, GQ11; KOBE-757..765.
  Runs beside KOBE-766 (mirror) and KOBE-768 (Files panel / Convert dialog).

## What ships

| Piece                                                                                                                                                                                                                                         | Where                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Contract (own commit): `pull_request` / `pushed` commit answers, `repo_moved`, `repo_unavailable`, `repo_push_rejected`, capability `repo_commits`, `run.start.git.repo`, frame `repo.status`; `repoCommitInfoSchema` (in the feature commit) | `packages/protocol/src/project-commits.ts`, `sandbox-wire/git-config.ts`                                                            |
| Tables `git_commit_branches` (a member's open pull request per Repo) and `git_working_copies` (ahead/behind per member and Repo): team tables, ENABLE + FORCE RLS, canonical policy, probe fixtures                                           | `packages/db/src/schema/git-repo-work.ts`, migrations `0253_git_repo_commits` (generated) + `0254_git_repo_commits_rls` (custom)    |
| Audit `git.repo.committed`, `git.repo.commit_failed`                                                                                                                                                                                          | `packages/db/src/audit/events/git.ts` + `.doc.ts`, table regenerated                                                                |
| Adapter `readTree(repository, sha)` (one level; GitHub refuses `truncated`, Gitea/Forgejo paged), contract test for all four adapters                                                                                                         | `services/server/src/git-hosts/trees.ts`, `github/adapter.ts`, `gitea/adapter.ts`, `testing/git-host-contract.ts`                   |
| Commit to a Repo: plan, rights, objects, tree edit, push, pull request, Kobe's copy                                                                                                                                                           | `services/server/src/git/repo-commit/*` (`commit.ts`, `tree-edit.ts`, `objects.ts`, `naming.ts`, `store.ts`, `dispatch.ts`)         |
| REST commit route and agent `commit_project` dispatch to it for a Repo                                                                                                                                                                        | `routes/project-commits/*`, `sandbox-wire/project-commit.ts`                                                                        |
| `run.start.git.repo`, `repo.status` intake, `GET /v1/projects/{id}/repo-status`                                                                                                                                                               | `git/working-copy.ts`, `sandbox-wire/delivery/run-start.ts`, `sandbox-wire/frames/repo-status.ts`, `routes/project-repo-commits.ts` |
| Web: Commit dialog hint/outcome/link, `repo_moved` → Update; Settings "Allow commits straight to the default branch"                                                                                                                          | `apps/web/components/projects/project-work.tsx`, `apps/web/components/admin/team/git/settings-dialog.tsx`                           |
| Sandbox agent: Repo working copy at `/workspace/repos/<slug>`, status reports, `.git` not synced, Repo outcomes of `commit_project`                                                                                                           | `services/sandbox-agent/src/git/working-copy.ts` and hooks (see "Sandbox agent" below)                                              |

## How a commit to a Repo works (ac-1, ac-2)

1. `planCommit(…, { repo: true })`: the usual checks (edit, checkout, base = Kobe's head else
   `commit_conflict`, diff, limits); only the `repo` write block is skipped.
2. G12: Contributor or above (`member` refused), repository `active`, connection present and at
   **Read and write**, Site decision, credential opens, repository re-read by host id: private (or
   internal where the connection allows it), not archived. Rate limit 60/h per member (shared
   limiter), one at a time per member and Repo per replica.
3. Objects: changed files' blobs read from Kobe's storage (SHA-256 checked, size capped), the
   conversion's path rules (`.git` spellings, `.gitmodules`, `.gitattributes` lines); the folders on
   changed paths read from the host (`readTree` of `mirror_head_sha`, ≤ 500 reads) and rewritten,
   all other entries keep their ids (links, submodules, files Kobe does not show stay as they
   are); a commit authored as the member (KOBE-764 identity, no-reply per Workspace setting),
   committer "<name> via Kobe", time now (UTC). Loose objects in `<tmp>/kobe-git-repo-commits/run-*`
   (removed after), packed and streamed by the conversion's `pack.ts` / `git-wire.ts` `postFile`.
4. Push = compare-and-swap, never forced:
   - **default (GQ11)**: new branch `kobe/<member slug>/<message slug>-<sha7>` from the mirror head,
     then `openPullRequest` into the default branch; row in `git_commit_branches`. Next commit with
     the same checkout base and mirror head, while the PR is open (`getPullRequest`), is pushed on
     top of the branch (old = recorded head; same tree → `nothing_to_commit`). A moved PR branch →
     a new branch and PR, never an overwrite. Closed/merged PR → new branch and PR.
   - **direct (`direct_commits`)**: default branch, old = mirror head. Refused and the host's head
     differs → `repo_moved` (409, "Update, then commit again"; `refreshMirror` hook called) and
     audited `commit_failed`. Refused otherwise (protected branch, hook) → pull request instead,
     `fallback: true`. Success → Kobe's copy takes the same commit (`commitWorkingCopy` with
     `repoMirror`: `writeCommit` allowed for the Repo, `mirror_head_sha` moved from the base in the
     same transaction, `expect` = the planned diff) so the checkout moves on; if the working copy
     changed meanwhile `seq` is null and the mirror refresh catches up.
5. Audit `git.repo.committed` (mode, sha, PR number/link, `opened`, `fallback`, `viaAgent` for an
   agent). Host text reaches the member only as receive-pack's short reason (`hostReason`).

**Why `readTree` over a fetch:** reading only the changed folders is a few small API calls and
keeps everything else on the host byte-identical; a shallow fetch of the base commit by SHA is not
allowed by every host (`allowReachableSHA1InWant`) and downloads the whole snapshot.

## Sandbox agent (ac-3)

`run.start.git.repo` (`z.object`, so older agents strip it) is sent for a thread in a Repo when the
member may converse, the repository is active and its connection is among the sandbox's
`remotes` (on, not agent-limited, https on 443). `access` = write for editor/owner + Contributor +
connection at Read and write. The agent keeps the working copy at `/workspace/repos/<slug>`
(cloned through the egress proxy by git running as the tools' identity with the tools' env),
reports `repo.status` at run start and end; the server keeps it only for a run of that member on a
thread in that Repo (≤ 30/min per connection; the end-of-run report arrives after the run ended,
so the run need not be active). Agent: `src/git/working-copy.ts` (fixed bash script, positional
args only, wrapped in `/usr/bin/timeout`: 120 s at start, 30 s at run end; strict parse of one
status line), `src/threads/tool-command.ts` (runs as the tools' uid via the identities helper with
the tools' env: egress BASH_ENV + token file, the thread's gitconfig), hooks in `thread.ts` /
`manager.ts`; `repo.status` allowed after run end in `wire/client.ts`; sync skips `repos/` (review M4)
(`workspace/fs.ts`, `sync.ts`, `sync/push.ts`); prompt text in `memory/project-context.ts`; git
never runs as the agent's own uid over the tool-owned repository. Not tested: the agent-level
`prepareRepo` → frame wiring and the tool-uid spawn path (the real-git test runs one uid).

## Decisions (owner to confirm)

- **Working copy at `/workspace/repos/<slug>`, not in `/workspace/projects/<slug>`.** The projects
  area is server-owned (read-only, evicts unknown files, relocks on checkout end); a `.git` there
  would need exceptions in the sync's security core. `projects/<slug>` stays Kobe's read-only copy
  of the default branch (readers, Commit dialog checkout); `repos/<slug>` is the git working copy.
  Since review M4 nothing under `repos/` is synced; a lost volume re-clones, so unpushed and
  uncommitted work there can be lost: the guide and the run context tell agents to push.
- **PR mode continues one pull request per member and working copy** while it is open (spec says
  "a new branch and a pull request"; a fresh PR per commit would repeat earlier changes, since a PR
  commit does not move the checkout base).
- **Direct commit refused by the host for another reason → pull request** (G18 "where the host
  permits it"), reported as `fallback`.
- **Direct commits write Kobe's copy at once** (with the mirror head) instead of waiting for
  KOBE-766's refresh, so the Commit dialog behaves as before (checkout moves on).
- **Old agents** (no `repo_commits`) get a Repo outcome as a failed call with words
  (`committed_as_pull_request` / `committed_to_default_branch`), never an unknown status.
- Limits: 60 commits/h per member; agent-limited connections are not checked for Kobe's dialog
  (no agent there); the agent tool path follows the project's edit rights and the approval as
  before (CM6) plus G12.

## Left for other tickets / coordinator

- **KOBE-766 wiring:** `RepoCommitDeps.refreshMirror` is a seam (unset); wire it to the mirror's
  refresh so `repo_moved` and an unrecorded direct commit catch up at once instead of on the
  timer. Until then `repo_moved` waits for the mirror's next refresh. The invariant relied on:
  Kobe's head ↔ `git_repositories.mirror_head_sha` (conversion and direct commits keep it).
- **KOBE-768:** Files panel ahead/behind from `GET /v1/projects/{id}/repo-status`
  (`working_copy`); the PR link (`pull_request`). `repo-status` path chosen so the OpenAPI
  "commit routes" check does not claim it.
- Contract split: `repoCommitInfoSchema` landed in the feature commit, not the contract commit.
- SHA-256 repositories: refused (`repo_unavailable`, Kobe's copy has no SHA-1 head).

## Docs

Guide: `admin/git-organizations.md` (Settings bullet, new "Commits to Repos"),
`files/workspaces-and-projects.md` ("Committing to a Repo", working copy),
`for-agents/working-with-git.md` ("Conversations on a Repo"). `docs/rate-limits.md` (two rows),
`docs/audit-log.md` (generated). OpenAPI: commit route answers, `repo-status` route.

## Evidence

- ac-1: `services/server/src/git-repo-commit.db.test.ts` "pushes a branch authored as the member
  and opens a pull request…" (real `git http-backend`, `fsck --strict`, author/committer/parent,
  PR title/body/base, joined PR, nothing to commit, closed PR → new PR, audit without paths);
  web `project-file-bar.test.tsx` "on a Repo, says where the commit goes and links the pull
  request"; `project-work.test.ts`.
- ac-2: same db file: direct commit (main moved by Kobe, Kobe's copy seq 2, mirror head, checkout
  diff empty, audit), moved default branch → 409 `repo_moved`, nothing overwritten, `commit_failed`;
  protected main (pre-receive hook) → PR with `fallback`; read-only connection / readers refused;
  `team-git-page.test.tsx` (setting sent, audited `git.connection.updated` in the db test).
- ac-3: db test "names the Repo in run.start.git and keeps the sandbox's ahead/behind"; sandbox
  agent tests (see below); `tree-edit.real-git.test.ts` (ids, order, edits vs real git).
- DB: `packages/db/src/git-repo-work.db.test.ts`, probe suite (918).
- Suites (2026-11-23): protocol 1372; db unit 1095; db DB git + probe 958; server unit 4540 (after
  the Site audit view fix); server test:db 3703 (two KOBE-765 tests updated: a Repo commit without
  a checkout is now `checkout_required`); web 4237; sandbox-agent 1284 (run it without
  `TMPDIR=~/tmp`: `runtime-dir.test.ts` depends on the default temp dir); typecheck, eslint,
  prettier, site wording, public hygiene.

## Stacked on KOBE-766 (2026-11-23)

- Merged `origin/group-107-git-10-mirror` (PR #696); migrations renumbered to `0255`/`0256` after
  the mirror's `0253`/`0254` (`scripts/onto-main.sh`), audit table regenerated, conflicts kept both
  sides (`writeCommit`'s flag is the mirror's `mirror`).
- **Wiring** (`git/repo-commit/wiring.ts`): after a direct commit, a `repo_moved` or a file
  conflict, `kickMirrorRefresh`; after a pull-request push, `requestMirrorRefresh` (the default
  branch did not move). The conversion now records `mirror_commit_id` = the converted head, and a
  direct commit sets it with `mirror_head_sha`, so `mirror_commit_id` always names the Kobe commit
  that is the copy of `mirror_head_sha`.
- **No clobbering:** both writers take the project row lock. A refresh re-reads `mirror_head_sha`
  under it: moved since its claim (by a direct commit) and not what it fetched → it writes nothing,
  releases and asks for a fresh refresh (`stale`); the unchanged path's `recordSuccess` only moves
  the head from the one it started on (`fromHead`). Kobe's copy of a direct commit is written only
  when `mirror_head_sha` is still the head it pushed onto. Test: "a refresh that read the host
  before a direct commit does not write it back".
- **Sweep (KOBE-766 review L1/R2-L3):** every refresh (changed or unchanged) drops the commits
  written into the Repo since its conversion (mirror and direct-commit copies) that are neither
  the head nor a checkout's base, unless a legal hold covers the Workspace; pre-conversion history
  stays. Audited in `git.repo.mirror_updated` (`prunedCommitId`, new `sweptCommits`) when the
  refresh wrote; a sweep on an unchanged refresh is not audited (no event fits; owner to confirm).
  Test: "sweeps a mirror commit a checkout kept alive once the checkout moved on".
- **Spawn as the tools' uid tested:** `threads/tool-command.test.ts` (a stand-in `kobe-runas`
  records the uid: partner with the executor, Pi uid without; `timeout`, env, output cap, refusal).

## Review g108 round 1 (2026-11-23)

Owner to confirm (coordinator's direction):

- **H1:** each commit is built on the host's current head of the default branch (or the open
  pull request's own base) and every changed path is checked three-way: the host's blob must still
  be Kobe's base version (or already the new content), else `repo_moved` and nothing is pushed;
  the push stays compare-and-swap from that head. Plan, repository row (`FOR SHARE`) and base tree
  are read in one transaction. Changes to other files on the host are kept. Tests: same file /
  different file on the host, and the race between plan and push (`afterPlan` hook).
- **M1:** an agent's commit (`via`) needs the connection to list the run's agent when it is limited
  to chosen agents (as KOBE-762's tools); the dialog has no agent. Test.
- **M2:** an agent's commit to a Repo is its own approval subject `commit_repo`: rules for
  `commit_project` never cover it, it always asks (no remember: refused with a message), the input
  and the card carry `pushes_to` (host, repository, pull request or branch). Ordinary projects are
  unchanged. Unit test of the decision (`commitSubject`); no end-to-end agent test (below).
- **M3:** `git.repo.commit_attempted` (commit id) before every push; after a push the host took,
  `git.repo.committed` first (three tries), then Kobe's records; any later failure is logged at
  error level and the answer stays a success. Test with a throwing write after the push.
- **M4:** nothing under `/workspace/repos/` is synced (scan, single push, deletions): the working
  copy is sandbox-local and re-clonable; quota, retention and legal hold are those of the project
  and the host, untouched by it. Guide (members and agents) and the run context say unpushed and
  uncommitted work there lives only on the sandbox's disk. A member's own `repos/` folder in My
  files is no longer synced while a sandbox runs (guide says so).

Lows: L1 fixed (`branchOf`: host name only if `assertBranch` passes). L2 fixed (429
`rate_limited` + `Retry-After`; counted only when the commit goes to the host). L3 **not fixed**:
a cross-replica lock needs a lease row or a held connection for minutes of host calls; the
outcome of a race is an extra pull request (never an overwrite, H1/CAS), and after Update a new
PR is opened by design (the old one may already be merged); the per-replica guard covers double
clicks. L4 fixed (origin re-pointed from `remote.origin.url`; real-git test). L5 fixed (no
identity and not the same uid → nothing runs; `sameUid` only without Pi identities; test). L6
fixed (guide and audit doc say refused by Kobe or the host). L7 fixed (wired). L8 fixed
(`PROJECT_SLUG_MAX`). L9 mostly fixed: H1 race, reader Contributor, rate limit, moved PR branch,
other Workspace's repo-status, spawn path; **left:** an end-to-end agent `commit_project` on a Repo
through the approval card (needs the agent fixture with a converted Repo; the decision and the
reply mapping are unit-tested) and the agent-level `prepareRepo` → frame test.
