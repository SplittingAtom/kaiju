# KOBE-766: GIT-10 Repo mirror: refresh on push, open and timer; read-only state when the host repository goes away

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `group-107-git-10-mirror` in `../Kobe-g107`
- **Depends on:** KOBE-757 (tables), KOBE-758/759 (adapters), KOBE-762/763 (tools, transport), KOBE-765 (Convert to repo)

## What was built

| Piece                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration: `git_repositories` gains the refresh schedule (`mirror_commit_id`, `mirror_attempted_at`, `mirror_error`, `mirror_failures`, `mirror_next_at`, `mirror_requested_at`, `mirror_lease_owner/until`); new team table `git_repository_commits` (newest 25 host commits per Repo: sha, author name, time, subject; no email), ENABLE + FORCE RLS, canonical policy, cascade with its repository row; probe fixture | `packages/db/src/schema/git.ts`, `schema/git-mirror.ts`, `0253_git_repository_mirror` (generated) + `0254_git_repository_mirror_rls` (custom), `tenancy/git.ts`, `testing/probe-fixtures/git.ts` |
| Fetch: `info/refs` head check, shallow fetch (depth 25) through the guarded smart-HTTP client, tree walk (symlinks/submodules skipped and counted), path rules (`fitsMount`), file/count caps, commit list as plain text                                                                                                                                                                                                 | `services/server/src/git/mirror/fetch.ts`                                                                                                                                                        |
| Inflation guard: every packed object's size read from the pack headers (deltas: target size from the first inflated bytes) before isomorphic-git inflates anything                                                                                                                                                                                                                                                       | `git/mirror/pack-sizes.ts`                                                                                                                                                                       |
| Refresh: lease per Repo, connection read budget (`git-tools:connection:read:<id>`, the 3,000/h one), connection + Site decision + credential per refresh, repository by host id (rename/transfer followed; not found → `deleted`; archived → `archived`), head unchanged → done, else fetch, hash, reserve + store new blobs, one transaction writes the mirror                                                          | `git/mirror/refresh.ts`, `apply.ts`, `store.ts`                                                                                                                                                  |
| Apply: one Kobe commit when the files differ (`writeCommit(..., { mirror: true })`, the only bypass of the Repo write block), previous mirror commit dropped unless a checkout is based on it or a hold applies, commit list replaced                                                                                                                                                                                    | `git/mirror/apply.ts`, `projects/tree.ts` (option `mirror`)                                                                                                                                      |
| Triggers: timer job `git-mirror` (one replica, lock `kobe.git-mirror`, every 1 min, due = not tried for 5 min, or requested); open (`GET .../repo` kicks a background refresh when older than 1 min); Refresh; sandbox push (transport decision for a Repo sets `mirror_requested_at = now() + 30 s`)                                                                                                                    | `git/mirror/job.ts`, `startup/jobs.ts`, `git/transport.ts`                                                                                                                                       |
| Routes `GET /v1/projects/{id}/repo`, `POST .../repo/refresh`, `.../repo/relink`, `.../repo/detach` (OpenAPI catalog entries, protocol schemas in a new file)                                                                                                                                                                                                                                                             | `routes/project-repo-mirror.ts`, `git/mirror/manage.ts`, `packages/protocol/src/git-mirror.ts`, `openapi/catalog/*projects-agents.ts`                                                            |
| Audit: `git.repo.mirror_updated`, `git.repo.host_state_changed`, `git.repo.relinked`, `git.repo.detached` (+ `previousRepositoryId` on the Site view allow-list)                                                                                                                                                                                                                                                         | `packages/db/src/audit/events/git.ts`, `git.doc.ts`, `docs/audit-log.md`, `audit/site-view.ts`                                                                                                   |
| For KOBE-767: `requestMirrorRefresh(tx, …)` / `kickMirrorRefresh(deps, …)` after a Kobe push; `repoReadOnly(tx, team, project)` to refuse commits to a read-only Repo                                                                                                                                                                                                                                                    | `git/mirror/store.ts`, `job.ts`                                                                                                                                                                  |

## Decisions (owner please confirm the starred ones)

- \* **Mirror limits = Kobe's project limits**: at most 500 files of at most 50 MiB, 1 GiB in all,
  pack ≤ 256 MiB. A repository beyond them is refused whole (`too_many_files`, …) and keeps its
  last mirror; no partial mirror. (Conversion only converts projects within these limits; a Repo
  that grows past 500 files on the host stops mirroring until it shrinks.)
- \* **Mirror commits are authored by the repository record's creator** (the member who converted
  or relinked), message `Mirror of <org/repo> at <sha12>`; `project_commits.author_user_id` must
  be a Kobe user. The host's own commit list (`git_repository_commits`) is what the panel shows.
- \* **Previous mirror commits are dropped** when a newer one lands (unless a working copy is based
  on it or a legal hold covers the Workspace): Kobe's history cap doesn't apply to a Repo (G17),
  so without this a busy repository would add a snapshot every 5 minutes forever. The project's
  pre-conversion history is never touched.
- \* **Relink and detach are allowed in any state**, not only when the Repo is read-only (the
  spec names them for the read-only case; nothing forbids them otherwise). Workspace admins only.
- A refresh counts as **one read** of the connection's hourly budget (it makes 2–4 host
  requests); a budget refusal defers without counting as a failure.
- The timer skips `deleted` and disconnected Repos; Refresh (a person) retries them, and goes
  past the back-off (still under the budget and its own per-member limit).
- Legal hold: a refresh that would remove files fails `legal_hold` and backs off (the 0078 guard
  refuses the delete anyway).
- A host repository that turned public is still mirrored (reading leaks nothing); relink refuses
  a public one (G10).
- No new Helm values: the interval (5 min) is a constant; documented in `docs/rate-limits.md`.
- `@kobe/protocol` gains `git-mirror.ts` (additive only, a new file) for KOBE-768's panel.

## Docs

- `docs/guide/admin/git-organizations.md`: new section "Repos: the mirror, read-only Repos,
  relink and detach" (refresh triggers, budget, back-off, limits, read-only states, relink,
  detach, audit events).
- `docs/guide/files/workspaces-and-projects.md`: short "Repos" section for members.
- `docs/guide/for-agents/working-with-git.md`: a Repo's mount is a mirror (lags a push by ~30 s).
- The panel itself (badge, Refresh button, banner, dialogs) is KOBE-768; its labels go in the
  guide with it.

## Evidence

- ac-1: `services/server/src/git-mirror.db.test.ts` "mirrors the host's files and newest commits"
  (a host commit adds/removes files, executable bit kept, commit list, unchanged second refresh,
  previous mirror commit dropped, audit counts); push request + timer due test.
- ac-2: same file, "records the failure, doubles the back-off and keeps serving the last mirror"
  (host 5xx → `host_unreachable`, 5 min then 10 min, not due, reads instant from the last mirror,
  Refresh recovers), "one refresh per Repo at a time", "refuses a repository larger than a project
  may be"; `git/mirror/fetch.real-git.test.ts` (caps, unsafe path, 4 MiB zero file refused from
  pack headers, delta sizes); `git/mirror/mirror.test.ts` (back-off, codes, rate-limit reset,
  budget deferral, index parsing).
- ac-3: same db file, rename followed, archived and deleted read-only + `git.repo.host_state_changed`,
  removed connection → `connection_removed` (Refresh 409), relink (owner 403, missing 404, public
  422, success mirrors the new repository, `git.repo.relinked`), detach (owner 403, admin 200,
  kind `project`, files kept, writes allowed, `git.repo.detached`).
- Test runs: see the final report of the ticket agent (counts per suite).
