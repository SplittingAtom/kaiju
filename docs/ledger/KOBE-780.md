# KOBE-780: Project path and tree rules (review pass 2: P2-8, 9, 41, 43, 45; then 42, 44)

- **Status:** in review (commits on `group-78-project-path-rules`, not pushed)
- **Branch / worktree:** `group-78-project-path-rules` in `../Kobe-g78`
- **Depends on:** none

## Findings checked against the code (before any change)

| Id    | Held?  | Evidence                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-8  | partly | Add to project (JSON `folder`, up to 1024 bytes), promote and revert could store a path whose `projects/<slug>/<path>` is over 1024 bytes; `reconcile()` writes a member's mounts in one transaction and `putServerFile` throws. The multipart **upload** cannot: its `path` field is capped at 256 bytes (`uploads/parse.ts` `MAX_FIELD_BYTES`). |
| P2-9  | yes    | `insertProjectFile` checked only the exact path.                                                                                                                                                                                                                                                                                                  |
| P2-41 | yes    | `DELETE /v1/projects/:id/files/:file_id` had no archived check.                                                                                                                                                                                                                                                                                   |
| P2-43 | yes    | `includes(".conflict-")` in commits, promote, from-proposal and also `sandbox-wire/file-edit-propose.ts` (a fourth copy).                                                                                                                                                                                                                         |
| P2-45 | yes    | Loop written three times; the UUID check in `sourceCheck` duplicated `isProjectKey`'s.                                                                                                                                                                                                                                                            |
| P2-42 | yes    | `deleteProject` let checkouts cascade without a word.                                                                                                                                                                                                                                                                                             |
| P2-44 | yes    | `lockTeamStorage` was taken before `writeCommit`, whose `refreshProjectStorage` aggregates every tree entry of the project.                                                                                                                                                                                                                       |

## Decisions

- **One rule module** `services/server/src/projects/paths.ts`: `fitsMount(slug, path)`, `isConflictCopy` (on
  `CONFLICT_COPY_PATTERN`), `clashesInTree` (moved from from-proposal). Slugs are immutable, so the mounted
  length is checked with the project's real slug (promote: the derived slug in the plan, the slug the
  project got inside the write, rolled back on a miss).
- **Where the length is enforced:** `insertProjectFile` (upload, Add to project; early check before
  streaming too), commit (`planCommit`, member rows), revert (only paths not already in the head),
  promote, accepted proposal. New file refusals: `path_too_long` (422 `invalid_input`), `path_clash`
  (409 `already_exists`, own message); no new protocol error code.
- **Existing over-long rows (no migration, nothing deleted):** mount reconcile skips them and logs a
  warning with team id, project id and count (no paths); checkout and Update leave them out; a commit
  keeps them in the tree (`withUnmountable`), so nobody loses the file by committing; `GET
/v1/projects/:id/files` marks them `path_too_long: true` and the project's Files list shows "Path
  too long to appear in members' files: delete it and add it again…". Revert refuses to bring one back.
- **P2-41:** checked in the route (`withProject` already holds the locked project row).
- **P2-45:** `projects/copy-loop.ts` `copyThenWrite` (+ `copyVerified`). The proposal path keeps its
  old `storage_failed` answer when rounds run out (pure refactor; the review suggests `changed`, which
  would need a new proposal status). Only order change: with no object storage configured, the
  proposal path answers `storage_failed` before the early quota check.
- **P2-42:** `GET /v1/projects/:id/checkouts` adds `changed_files` per working copy; the delete
  confirmation names how many members have uncommitted changes. The delete audits
  `project.checkout_discarded {reason: project_deleted}` per checkout and `workingCopies`,
  `uncommittedWorkingCopies` on `project.deleted` (both optional in the event schema). Not done: the
  review's alternative of blocking the delete on checkouts (the ticket asked for a warning).
- **P2-44:** the team storage lock is taken after `writeCommit` (inside a savepoint where needed) by
  `checkLimitsAfterWrite`, which checks `used > limit` for the limits the write added to (same answers
  as `used + added > limit` before; a refusal rolls back). Lock order otherwise unchanged (project row,
  member workspace, then storage). Not done: incremental counters, the `(team_id, sha256)` index for
  `heldContents` (needs a migration) and an index-backed `membersOf`.

## Left out / follow-ups

- Update's conflict copy (`<name>.conflict-<time>`) of a path within ~25 bytes of the limit can still be
  too long and fail the Update (pre-existing, not in the findings).
- `canAddToProject` and the `clean()`/`assertOwnedKey` duplication from P2-45 left as they are.

## Docs (docs/guide evaluation)

- `files/storage-limits.md`: project path rule (1,024 bytes as mounted), no file inside a file, which
  `.conflict-` names are refused, the "Path too long" mark; promote refusal.
- `files/workspaces-and-projects.md`: archived project files are frozen; deleting a project names
  uncommitted working copies.
- `docs/audit-log.md`: new `project.deleted` fields and `project_deleted` reason. The For-agents pages
  need no change (agent tools behave the same; only a real conflict copy is refused).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/project-path-rules.db.test.ts` (P2-8 import refusal, reconcile/checkout/
  commit around an old row, revert; P2-9; P2-41; P2-43), `src/projects/paths.test.ts`;
  `project-proposals.db.test.ts` now uses a real conflict-copy name.
- ac-2: commit `refactor:`; project commit/promote/proposal DB tests unchanged and green.
- ac-3: P2-42 test in `project-path-rules.db.test.ts` + web `projects.test.tsx`; P2-44 quota boundary
  test (upload bytes/objects exact) in `project-path-rules.db.test.ts`.
- Runs: format:check, lint, server and web typecheck, server unit suite, `test:db` (see final report).
