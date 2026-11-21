# KOBE-740: Sweep object-store orphans outside thread trees (review STO-9)

- **Status:** in review (group 60)
- **Branch / worktree:** `group-60-storage-ops` in `../Kobe-g60`
- **Depends on:** none

## Decisions (per shape)

- **Project file staging and file keys** (`projects/<p>/staging/<uuid>`, `projects/<p>/files/<id>`):
  **queued.** Both keys are reserved in `retention_blob_deletions` (`queueProjectBlobs`,
  "reservation", due in 6 h) before the first byte. The project tree is already a tree the blob
  deleter deletes in (KOBE-579 rules: unreferenced by trees/head/workspace rows, no hold in the
  team), and commits already clear reservations of the keys they reference (`writeCommit`), so the
  file key needs no new code on success. A key `uploadProjectFile` deletes itself drops its row;
  one it cannot delete stays queued.
- **Member-level uploads** (`teams/<t>/users/<u>/uploads/<uuid>`): **orphan sweep.** The key is
  outside every tree the queue deletes in (thread, project); widening the deleter to user trees
  would loosen its rule for every queued key. The sweep already lists user folders (KOBE-243,
  removed members too) and checks blob columns (`files.blob_ref`) and the user's hold.
- **Skill bundle attempts** (`skills/teams/<t>/<sha>/<uuid>`, `skills/users/<u>/<sha>/<uuid>`):
  **orphan sweep.** Not under `teams/<t>/`, and personal skills have no team, so they cannot be
  queued (`retention_blob_deletions` is a team table). Swept in each team's pass: the team's own
  attempts (any hold in the team keeps them) and the personal attempts of its members and
  workspace users (the user's hold in that team keeps them). Protection checks also the site-wide
  columns (personal and catalog versions) for skill keys. Versions are immutable, so an
  unreferenced attempt key is only ever a failed or crashed upload. Limitation: a hold on a user
  in another team is not visible to this team's pass; an attempt never committed is part of no
  record.
- **Skill eval objects** (`teams/<t>/skill-evals/<uuid>/{bundle,fixtures}-<sha>.zip`), traced:
  `skills/evals/start.ts` puts both before the run row commits (a crash leaves them), and the
  eval purge deletes after its commit and only logs a failure. Per-run uuid keys, so **added to
  the orphan sweep** (unreferenced by `skill_eval_runs`, any hold in the team keeps them).
- **Memory docs** (`teams/<t>/memory/<doc>/<version>`), traced: the put happens inside the write
  transaction; a rollback or crash after it leaves the object. For an existing doc the next write
  of that version overwrites it; for a doc created in the rolled-back transaction (version 1 of a
  doc id that never commits), or a doc later purged before another write, it stays. **Not swept
  here:** the key is deterministic and reused, so a sweep could delete an object a concurrent
  writer has just overwritten and is about to commit (the uuid-keyed shapes have no such race).
  Follow-up suggestion: a per-write unique key, or a reservation like project uploads.
- `skills/catalog/<sha>` (catalog objects) are content-addressed and re-used by the next write of
  the same bytes; not in scope.

## Docs

No user-, admin- or agent-visible change (internal cleanup of crash leftovers); no guide change.

## Evidence

- ac-1: `services/server/src/retention/crash-windows.db.test.ts`: a store that keeps the bytes and
  then fails, and refuses deletes, simulates a crash between put and commit: project staging (and
  a failed commit after the copy) deleted by the blob deleter once due; member upload, team and
  personal skill attempts and eval objects deleted by the orphan sweep once older than the grace;
  committed objects and referenced uploads kept; a team-wide hold keeps team attempts.
  `retention/orphans.db.test.ts` updated for the new counts.
- ac-2: memory docs and skill-eval prefixes traced above.
