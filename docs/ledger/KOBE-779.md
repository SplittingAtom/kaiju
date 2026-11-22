# KOBE-779: Memory write paths: every save embedded; candidate scope; stale update refused

- **Status:** in review (group 74, branch `group-74-memory-write-paths`)
- **Branch / worktree:** `group-74-memory-write-paths` in `../Kobe-g74`
- **Depends on:** none

## Plan

Review pass 2 findings P2-5, P2-6, P2-46, each checked against main (a303f342) first. All three held:

- P2-5: `afterSave` had two callers (item routes, import route); To review Save/Undo and both
  proposal decides wrote versions without a vector.
- P2-6: `screen.ts` `verdictFor` took `destination` from `suggested_scope`/`portable`, never the
  target's scope, so `allowedScopes` locked a targeted card to the wrong scope.
- P2-46: `saveLocked` passed the target's _current_ version as `expected_version`.

## Decisions

- **Embedding in one place.** `insertVersion` takes the op and lists the item in `Op.saved`
  (restore lists it too). `afterCommit(db, ops)` in `items/context.ts` runs after every store
  transaction (`inStore`, To review's `inReview`, Workspace and Site proposal decides): it queues
  `MemoryEmbeddings.afterSave` and sends the near-full notices. The service is found through a
  `WeakMap<KobeDb, embedder>` (`memory/embeddings/save-hook.ts`) registered in `deps.ts`, so store
  functions keep their `(db, who, …)` signatures and two servers in one process stay separate.
  The route-level `afterSave` calls are gone (no double embedding). Background and failing soft as
  before: a refusal keeps the save; Build vectors embeds it later.
- **Target scope.** A candidate with `target_id` takes the listed target's scope as destination
  (user/portable/team); Workspace evidence rules use that scope; an inferred one aimed at a team
  item becomes `team` and the selection drops it (`inferred_shared`); a project-specific update of
  a team item stays `team`. Old stored candidates keep their stored destination (they expire).
- **Base version.** The related items carry `version` (never shown to the model: `itemLine` lists
  fixed fields); the screened candidate keeps `targetVersion`, stored as `target_version`. Save of
  an update or supersede refuses with 409 `memory_version_conflict` and "The memory this candidate
  changes was changed since Kobe suggested this…" when the target moved past it; nothing is
  written, so the card stays open. The list adds `target_changed`; the card then says so and its
  Save sends `target_version` (the version shown, re-checked against current). A 409 for a card that
  didn't say so shows **Reload**, which now reads the cards again. Candidates stored without a base
  act on the current version (old behaviour).
- **Guide:** `docs/guide/memory.md` To review (target scope, changed-since notice, Reload) and
  Vectors (every save path, failure keeps the save).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/memory-vectors-save-paths.db.test.ts` (To review Save add + update,
  Undo, Workspace proposal approval each get a vector; a refused embed keeps the save, Build
  vectors fills it).
- ac-2: `memory/learn/screen.test.ts` "a candidate acting on an existing item"; DB:
  `memory-review.db.test.ts` "a targeted Workspace candidate saves into the Workspace item".
- ac-3: `memory-review.db.test.ts` "is refused with a reason, stays open, and saves once the person
  reviewed the change"; web `review-section.test.tsx` (notice + `targetVersion`, Reload refetch).
