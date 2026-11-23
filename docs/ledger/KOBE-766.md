# KOBE-766: GIT-10 Repo mirror: refresh on push, open and timer; read-only state when the host repository goes away

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `group-107-git-10-mirror` in `../Kobe-g107`
- **Depends on:** KOBE-757 (tables), KOBE-758/759 (adapters), KOBE-762/763 (tools, transport), KOBE-765 (Convert to repo)

## What was built

| Piece                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration: `git_repositories` gains the refresh schedule (`mirror_commit_id`, `mirror_attempted_at`, `mirror_error`, `mirror_failures`, `mirror_next_at`, `mirror_requested_at`, `mirror_lease_owner/until`); new team table `git_repository_commits` (newest 25 host commits per Repo: sha, author name, time, subject; no email), ENABLE + FORCE RLS, canonical policy, cascade with its repository row; probe fixture | `packages/db/src/schema/git.ts`, `schema/git-mirror.ts`, `0253_git_repository_mirror` (generated) + `0254_git_repository_mirror_rls` (custom), `tenancy/git.ts`, `testing/probe-fixtures/git.ts` |
| Fetch: `info/refs` head check, shallow fetch (depth 25) through the guarded smart-HTTP client, tree walk (symlinks/submodules skipped and counted), path rules (`fitsMount`), file/count caps, commit list as plain text                                                                                                                                                                                                 | `services/server/src/git/mirror/fetch.ts`                                                                                                                                                        |
| Pack reader (review H1): own upload-pack request, pack streamed to the work folder, SHA-1 trailer checked, each object's size read from its header before inflation, inflation capped at that size, delta target size checked before applying, total and count capped, objects written loose one at a time                                                                                                               | `git/mirror/pack-unpack.ts`                                                                                                                                                                      |
| Refresh: lease per Repo, connection read budget (`git-tools:connection:read:<id>`, the 3,000/h one), connection + Site decision + credential per refresh, repository by host id (rename/transfer followed; not found → `deleted`; archived → `archived`), head unchanged → done, else fetch, hash, reserve + store new blobs, one transaction writes the mirror                                                          | `git/mirror/refresh.ts`, `apply.ts`, `store.ts`                                                                                                                                                  |
| Apply: one Kobe commit when the files differ (`writeCommit(..., { mirror: true })`, the only bypass of the Repo write block), previous mirror commit dropped unless a checkout is based on it or a hold applies, commit list replaced                                                                                                                                                                                    | `git/mirror/apply.ts`, `projects/tree.ts` (option `mirror`)                                                                                                                                      |
| Triggers: timer job `git-mirror` (one replica, lock `kobe.git-mirror`, every 1 min, due = not tried for 5 min, or requested); open (`GET .../repo` kicks a background refresh when older than 1 min); Refresh; sandbox push (transport decision for a Repo sets `mirror_requested_at = now() + 30 s`)                                                                                                                    | `git/mirror/job.ts`, `startup/jobs.ts`, `git/transport.ts`                                                                                                                                       |
| Routes `GET /v1/projects/{id}/repo`, `POST .../repo/refresh`, `.../repo/relink`, `.../repo/detach` (OpenAPI catalog entries, protocol schemas in a new file)                                                                                                                                                                                                                                                             | `routes/project-repo-mirror.ts`, `git/mirror/manage.ts`, `packages/protocol/src/git-mirror.ts`, `openapi/catalog/*projects-agents.ts`                                                            |
| Audit: `git.repo.mirror_updated`, `git.repo.host_state_changed`, `git.repo.relinked`, `git.repo.detached` (+ `previousRepositoryId` on the Site view allow-list)                                                                                                                                                                                                                                                         | `packages/db/src/audit/events/git.ts`, `git.doc.ts`, `docs/audit-log.md`, `audit/site-view.ts`                                                                                                   |
| For KOBE-767: `requestMirrorRefresh(tx, …)` / `kickMirrorRefresh(deps, …)` after a Kobe push; `repoReadOnly(tx, team, project)` to refuse commits to a read-only Repo                                                                                                                                                                                                                                                    | `git/mirror/store.ts`, `job.ts`                                                                                                                                                                  |

## Decisions (owner please confirm the starred ones)

- \* **Mirror limits = Kobe's project limits**: at most 500 files of at most 50 MiB, 512 MiB in all,
  pack ≤ 128 MiB. A repository beyond them is refused whole (`too_many_files`, …) and keeps its
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
- The timer re-checks `deleted` Repos every 6 hours and skips disconnected ones (nothing to
  check against); Refresh (a person) goes past the doubling back-off but not a host rate-limit
  reset or the budget window (review L2).
- Legal hold: a refresh that would remove files fails `legal_hold` and backs off (the 0078 guard
  refuses the delete anyway).
- A host repository that turned public is still mirrored (reading leaks nothing); relink refuses
  a public one (G10).
- No new Helm values: the interval (5 min) is a constant; documented in `docs/rate-limits.md`.
- `@kobe/protocol` gains `git-mirror.ts` (additive only, a new file) for KOBE-768's panel.

## Review round 1 (review-g107.md) — what changed

- **H1** `git.fetch` replaced by `pack-unpack.ts` (see the table): nothing over the 50 MiB object
  cap is ever inflated or applied; a stream that inflates past its stated size is cut by zlib's
  `maxOutputLength`; pack cap lowered to 128 MiB and streamed to disk. Tests: `pack-unpack.test.ts`
  (64 MiB of zeros in a < 1 MiB pack, a lying size header, a 64 MiB delta bomb, each refused with
  external memory growth < 8 MiB; total/count caps; bad trailer) and the real-git 64 MiB zero file.
- **M1** `claimRefresh` counts the attempt (failures + 1, back-off, `interrupted` when no code),
  settled by success, failure or deferral; a run ends within 8 min (lease 10 min), checked in the
  unpack, tree walk and blob loops. Test: claim then "die" → backs off, not due.
- **M2** "not found" is `repository_not_found` (a failure with back-off, Repo not read-only) until
  4 in a row (≥ 35 min); `deleted` Repos are re-checked every 6 h and return to `active`. Tests.
- **M3** relink to another repository starts without a mirror commit, so the old last mirror stays
  in history; the same repository keeps its own. Test asserts the old commit survives.
- **L1** `prunedCommitId` on `git.repo.mirror_updated`. The sweep of older mirror commits is
  **deferred to KOBE-767** (corrected in round 2): Repos _can_ be checked out today
  (`POST /v1/projects/{id}/checkout` needs only `edit`), and every mirror commit a checkout is
  based on is skipped by the prune and never removed later (retention skips Repos). This is a
  storage-only leak (one snapshot's tree rows and the blobs only it holds, per checkout per mirror
  update), not a correctness or safety issue. KOBE-767 defines checkouts and commits on Repos and
  should add a reliable marker (a nullable `mirror_repository_id` on `project_commits`) and the
  sweep.
- **L2** Refresh answers 429 `host_rate_limited`/`connection_budget` with Retry-After. Test.
- **L3** opens refresh only when older than the 5-minute interval.
- **L4** control characters (NUL included) stripped from author/subject; out-of-range times
  become the epoch.
- **L5** `deleted`/`unreachable` writes under the lease; relink and detach revoke the lease.
- **L6** claim clears only a due request; a kicked refresh that finds no slot (or a held lease)
  asks for one instead.
- **L7** relink re-checks the admin role under the lock; `is_private = true` on conflict.
- **L8** partly: a pending push request is no longer pushed forward by later decisions; one
  refresh per Repo per minute at most remains possible (≤ 60 budget reads/h per Repo), accepted.

## Review round 2 — what changed

- **R2-M1** per-refresh disk budget (`GIT_MIRROR_MAX_DISK_BYTES` 768 MiB): the pack plus every
  loose object as stored, counted as each is written. Inflated cap lowered to 768 MiB, head
  content cap to 512 MiB (\* owner to confirm: was 1 GiB). Two refreshes (1.5 GiB) plus a
  conversion (~4 GiB) fit `server.tmpSizeLimit` 6 GiB (chart comment updated; value unchanged).
  Test: a ~260 KiB pack of 40 one-byte delta variants of a 256 KiB random blob stops at the budget.
- **R2-L1** delta data counts against the inflation total as it is inflated; deltas waiting for a
  base are kept in a map by base position/id and resolved iteratively when it arrives (linear);
  object cap 20,000. Tests: orphan deltas refused by the total; a 300-long reverse ref-delta chain
  resolves in one pass. Memory per refresh (~200 MiB worst) noted in `limits.ts`.
- **R2-L2** Refresh honours `mirror_next_at` after `repository_not_found` too (429). Test.
- **R2-L3** L1 reason corrected above.
- **R2-L4** upload-pack 403 → `credential_forbidden`; a pack over the object cap is
  `repository_too_large` with detail `objects`.

## Review round 3 — what changed

- **R3-M1** one shared set of Repo limits (`services/server/src/git/repo-limits.ts`: 500 files,
  50 MiB per file, 512 MiB at the tip of the default branch), used by the mirror and by Convert to
  repo, which now refuses a project whose current files exceed them (422 `too_large_to_mirror`,
  with a message naming the limit; the 2 GiB history ceiling stays). A Repo that grows past them
  on the host shows `mirror.too_large: true` and a plain message ("too large to mirror … Kobe keeps
  showing the last mirror"). Tests: conversion of a project with 539 MiB of current files refused (the database caps a project at 500 files, so the total is the reachable limit); view flag and message.
- **R3-L1** `server.tmpSizeLimit` default 6Gi → 8Gi: conversion 4 GiB + mirror 2 × (768 MiB + one
  50 MiB object) ≈ 1.6 GiB + 2.4 GiB for other temporary files; chart comment, schema description,
  `docs/install.md` and the chart test updated.
- **R3-L2** every replica removes stale mirror work folders at start (older than this process and
  than a lease), not only the job-lock holder; the conversion sweep already runs on every replica
  (no lock). The waiting-delta list appends in place (round-2 cosmetic note).

### Owner to confirm (numbers chosen by the coordinator, 2026-11-23)

- Repo content limit **512 MiB** of files at the default branch's tip (with 500 files, 50 MiB per
  file: Kobe's project limits), shared by the mirror and Convert to repo.
- **768 MiB** per refresh: on disk (pack plus objects) and inflated in all.
- **20,000** objects per fetched pack; pack download **128 MiB**.
- `server.tmpSizeLimit` default **8Gi**.

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
  may be"; `git/mirror/fetch.real-git.test.ts` (caps, unsafe path, 64 MiB zero file refused before
  inflation, repacked repository), `git/mirror/pack-unpack.test.ts`; `git/mirror/mirror.test.ts` (back-off, codes, rate-limit reset,
  budget deferral, index parsing).
- ac-3: same db file, rename followed, archived and deleted read-only + `git.repo.host_state_changed`,
  removed connection → `connection_removed` (Refresh 409), relink (owner 403, missing 404, public
  422, success mirrors the new repository, `git.repo.relinked`), detach (owner 403, admin 200,
  kind `project`, files kept, writes allowed, `git.repo.detached`).
- Test runs (round 1 fixes): server unit 4,537 passed; server `test:db` 3,708; `@kobe/db` DB suite
  2,147 (whole suite); lint, typecheck, format:check, site wording, public hygiene clean.
