# KOBE-765: GIT-9: Convert to repo: repository creation, history carried as git commits, project marked as a Repo

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-104-git-9-convert-to-repo` in `../Kobe-g104`, stacked on PR #692 (phase 2)
- **Depends on:** spec `docs/specs/workspace-git.md` G15-G17, GQ4, GQ12, GQ13, §9; KOBE-757..764

## What ships

| Piece                                                                                                                                                                                | Where                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table `git_conversions` (team table, ENABLE + FORCE RLS, canonical policy; SQL-only SET NULL keys to the connection and the repository row; cascade with the project); probe fixture | `packages/db/src/schema/git-conversions.ts`, migrations `0250_git_conversions` (generated) + `0251_git_conversions_rls` (custom), `tenancy/git.ts`, `testing/probe-fixtures/git.ts` |
| Contract (own commit): body, attempt view, refusal and failure codes; `project_is_repo` / `conversion_in_progress` commit error codes                                                | `packages/protocol/src/git-conversions.ts`, `project-commits.ts`                                                                                                                    |
| Routes `GET/POST /v1/projects/{id}/repo-conversion`, `POST …/retry`, `POST …/abandon` (OpenAPI catalog + details, route inventory)                                                   | `services/server/src/routes/project-repo.ts`                                                                                                                                        |
| Job: start checks, plan, runner, push, resume sweep (`git-conversion-resume` in `startup/jobs.ts`), email                                                                            | `services/server/src/git/conversion/*`                                                                                                                                              |
| Guarded git smart-HTTP client for isomorphic-git                                                                                                                                     | `services/server/src/git-hosts/git-wire.ts` (`GitHostNet.wire` test seam, `gitWireSend` deps option)                                                                                |
| Kobe writes refused for a Repo / during a conversion                                                                                                                                 | `projects/repo-state.ts`, checked in `writeCommit` and early in every write path                                                                                                    |
| Audit `git.project.conversion_requested                                                                                                                                              | converted                                                                                                                                                                           | conversion_failed | conversion_retried | conversion_abandoned` | `packages/db/src/audit/events/git.ts` + `.doc.ts`, table regenerated |

## How history is built and pushed (decision)

- **isomorphic-git (MIT, already a server dependency since KOBE-343), no new dependency.** The
  server image has no `git` binary; writing packfiles by hand was rejected: isomorphic-git is
  already trusted for server pushes (skill mirror), handles receive-pack negotiation, thin packs and
  fast-forward checks, and its objects pass `git fsck --strict` and a `receive.fsckObjects` host
  (tests). Objects go to a bare repository in the server's temp dir (an emptyDir in the chart),
  removed after each run.
- **Bounded memory.** isomorphic-git builds each push's pack in memory, so commits are pushed in
  batches of ~32 MiB of new content (each a fast-forward of the default branch); one file is in
  memory at a time while objects are written (≤ a project file, 50 MiB). The request body is sent
  from isomorphic-git's chunks without another copy. Limits (refused before anything starts, named
  in the answer): distinct content ≤ min(connection push limit, 2 GiB) (`project_too_large`); one
  commit's new content ≤ 256 MiB (`commit_too_large`, naming the commit; "convert without
  history" for the current files). Git LFS is out of scope (§10); host file limits: GitHub 100 MiB
  (Kobe's 50 MiB cap is below), Gitea/Forgejo none by default.
- **Transport from the server only**, with `repositoryCredential(repo, "write")` (an App token
  narrowed to the repository, or the connection's token), never through a sandbox or the egress
  proxy: `gitWireClient` re-checks the Site decision (`gitHostTarget`/`assertRequestHost`) and the
  connectors' address policy on every request, connects to the checked address (`pinnedLookup`,
  now exported), reaches only the repository's three smart-HTTP endpoints, refuses redirects,
  drops any `Authorization` isomorphic-git sets and adds the Basic credential, caps time and size.
- **Deterministic commits** (`plan.ts`, `objects.ts`): the plan (Kobe commit ids, author,
  committer, time, message) is frozen in the attempt row at start; blobs are verified against
  Kobe's SHA-256; trees in git order, `100755` for executable files; commit time = the Kobe
  commit's time (UTC) for author and committer; message = Kobe's, trimmed, one newline. Author =
  the member who committed (an agent's commit: the member whose conversation it was, as Kobe
  records it), email per the Workspace's commit-email setting (`buildRunGitContext`, KOBE-764);
  committer `<name> via Kobe`. A deactivated member keeps the name with the no-reply address (never
  the mailbox); a member Kobe no longer knows becomes "Former member" (spec is silent: my choice).
  Without history: one commit of the current files, authored by the requester at request time.

## State machine

```
            start (route, project row lock: checks, plan, insert, audit requested)
                 │
                 ▼
  ┌─ running ─────────────────────────────────────────────────────────────┐
  │  create ──(repo created/adopted; host id + git_repositories row      │
  │            recorded in one txn)──▶ push ──(all batches taken)──▶     │
  │  finish ──(host head == plan head, default branch ours; ONE txn:      │
  │            projects.kind='repo', repo row linked + mirror head,      │
  │            attempt completed, audit converted)──▶ done = completed   │
  └──────┬────────────────────────────────────────────────────────────────┘
         │ any step fails (host, storage, connection, …)
         ▼
      failed ──retry (owner/admin; resumes at step)──▶ running
         │
         └──abandon (owner/admin)──▶ abandoned (project ordinary again;
                                      created repo left on host, reported)
  crash/restart while running: lease (2 min, renewed 30 s) lapses → resume sweep claims it
  (every replica, atomic claim) → continues at `step`.
```

While `running` or `failed` the project takes no Kobe writes (`conversion_in_progress`); one such
attempt per project (partial unique index).

## Idempotency

- **Create:** `create_attempted_at` is written before the call; the new repository's description
  carries `kobe-conversion:<attempt id>`. A retry that finds the name taken adopts it only with
  that marker and no refs; anything else is `repository_exists` (never adopted). The host id and
  the `git_repositories` row are recorded in the same transaction that moves to `push`. A chosen
  existing repository (`use_existing`, G16) must exist, be non-public and have no refs.
- **Push:** the host's branch head must be one of the plan's commits (deterministic hashes); the
  push continues after it; anything else is `repository_changed`. Progress per batch is recorded.
- **Finish:** re-reads the host's branch; marks the project in one transaction under the project
  row lock (the lock every Kobe write takes), checking the head did not move (`project_changed`).
- Every job write names its lease (`lease_owner`): a replica that lost its claim changes nothing.

## Failure matrix

| Step        | Cause                                                                       | Code                                                             | Project               | Path out                                            |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------- | --------------------------------------------------- |
| any         | connection removed / below Read and write / Site refuses host / no envelope | `connection_unavailable`                                         | ordinary              | fix, retry; or abandon                              |
| any         | credential opens badly / host 401                                           | `credential_rejected`                                            | ordinary              | admin replaces credential, retry                    |
| any         | host 403                                                                    | `credential_forbidden`                                           | ordinary              | grant permission, retry                             |
| any         | timeout, DNS, 5xx                                                           | `host_unreachable`                                               | ordinary              | retry                                               |
| any         | rate limit                                                                  | `host_rate_limited`                                              | ordinary              | retry later                                         |
| create      | name taken, not ours                                                        | `repository_exists`                                              | ordinary              | abandon, convert with another name / `use_existing` |
| create      | chosen repo has refs / is public / missing                                  | `repository_not_empty` / `repository_public` / `repository_gone` | ordinary              | abandon                                             |
| push        | recorded repo deleted/transferred, archived                                 | `repository_gone` / `push_rejected`                              | ordinary              | abandon (repo row stays)                            |
| push        | object missing or wrong hash in storage                                     | `content_missing` (names file)                                   | ordinary              | retry; Site admin                                   |
| push        | host refuses (hook, size)                                                   | `push_rejected`                                                  | ordinary              | fix on host, retry                                  |
| push/finish | someone else pushed                                                         | `repository_changed`                                             | ordinary              | reset branch, retry; or abandon                     |
| finish      | host default branch differs                                                 | `default_branch_mismatch` (names it)                             | ordinary              | set on host, retry                                  |
| finish      | project head moved (backstop)                                               | `project_changed`                                                | ordinary              | retry                                               |
| any         | replica dies                                                                | — (stays running)                                                | ordinary, writes held | resume sweep after 2 min                            |

Abandon never deletes on the host (§9): the answer's `left_on_host` names a repository the host
created for the attempt; its `git_repositories` row (origin `conversion`, no project) keeps it in
the Git section's repositories list. Each failure is audited and emailed to the requester.

## After conversion (until GIT-10/11)

- `projects.kind = 'repo'`; `git_repositories` linked with `mirror_head_sha` = the pushed head and
  `mirror_refreshed_at`. `project_files` and Kobe's history stay as they were: they equal the
  pushed head, so the Files panel, mounts, downloads and history read as before (read-only).
- Every Kobe write refuses with 409 `project_is_repo` (REST) / `not_allowed` with the same words
  (agent `commit_project`): commit, revert, upload, Add to project, accepted proposal, file removal
  (`writeCommit` itself throws for a Repo, so a path that forgets the early check still cannot write).
- History pruning (GV3) skips Repos (G17: the cap no longer applies; Kobe's pre-conversion history
  is kept as it was) and projects with a running or failed attempt.
- Legal hold: a start or retry is refused while any hold covers the Workspace (the projects rule,
  `memory_legal_hold_covers(team, NULL)`). After conversion a hold covers Kobe's frozen copy, which
  nothing deletes; the repository on the host is outside Kobe's retention and erasure (§9).

## Guide text for GIT-12 (the dialog) and GIT-13

The Convert to repo dialog and its guide page must say: who may convert (owner, Workspace admins)
and that it needs a connection at Read and write; that it is one-way; what is carried (each
commit with author, time and message; or one commit of the current files) and how authors appear
(Kobe email or no-reply per the Workspace setting; members who left: no-reply; "via Kobe"
committer); that the repository is private (internal only where the connection allows it);
every refusal's words (`refusals.ts`), incl. the size limits, `.git` paths, unsaved working
copies and legal hold; that it runs in the background and emails the result; retry and abandon,
and that abandoning leaves a created repository on the host for an admin to delete or reuse;
that afterwards the host's default branch is the record and Kobe shows the files read-only until
committing to a Repo lands; that the repository is outside Kobe's retention, erasure and legal hold.
No guide page changes in this ticket: no UI can start a conversion yet (GIT-12 owns the dialog
and its page; the API is in the OpenAPI catalog).

## Left / open

- **Bell notification:** emails only (as KOBE-760's expiry notices); a bell kind needs protocol +
  the `notifications_kind` CHECK + web rendering. Suggest one follow-up for both.
- **Undecided (spec silent):** identity of deactivated/unknown members (above); whether pruning
  should ever drop a Repo's pre-conversion Kobe history (kept).
- Clean checkouts of a converted project stay; their edits cannot be committed until GIT-11.
- No automatic retry of transient failures (a person retries); add backoff if it proves noisy.
- `unsaved_checkouts` refusal is covered by code review and the shared `projectCheckouts`, not a
  DB test (needs the workspace-sync world).

## Evidence

- ac-1: `services/server/src/git-conversion.db.test.ts` "writes every commit with its author and
  message" (real `git http-backend`, `receive.fsckObjects`, `fsck --strict`, `git log` authors,
  committers, original times, bodies, modes; project `repo`, repository row, audit, email; writes
  refused after); `git/conversion/history.real-git.test.ts` (batches, determinism, wire rules).
- ac-2: db test "refusals name the reason", "resumes a push a crash interrupted", "adopts after
  an interrupted create only the repository this attempt created", "a failed push … retry …
  abandon"; `git/conversion/conversion.test.ts`.
- ac-3: `git.project.converted` asserted in the db test; `packages/db` `git.db.test.ts` (table
  shape, active-attempt uniqueness, isolation, SET NULL/cascade) and the probe suite.
