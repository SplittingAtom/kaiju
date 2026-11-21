# KOBE-711: Split threads/repository.ts and agents/versions.ts (review CODE-6)

- **Status:** in review (group 66 branch `group-66-repo-splits-openapi`)
- **Branch / worktree:** `group-66-repo-splits-openapi` in `../Kobe-g66`
- **Depends on:** none

## Plan

Pure move along the seams named in the review; no query, `withTeam()` scope or transaction
boundary changes. Both old paths stay as re-export shims so importers (58 for the repository,
39 for versions) and other in-flight branches keep compiling unchanged.

## Decisions

- `services/server/src/threads/`: `queries.ts` (types, visibility predicates, summaries, lists,
  `findThread(s)`, `hasRunIn`, `listEntries`), `mutations.ts` (create, `lockFor*`, update, leaf,
  agent switch, Trash/restore, clear test threads), `projects-view.ts` (`viewableProjects`,
  `canViewProject`, `maskedProject`, `sharerNames`). `projects-view.ts` imports only types from
  `queries.ts`, so there is no runtime cycle. `TRASH_INTERVAL` is now exported from
  `queries.ts` (used by `restoreThread`) but not re-exported from `repository.ts`.
- `services/server/src/agents/versions/`: `records.ts` (types, columns, `toVersion`, reads,
  `currentMemory`, audit `ref`), `publish.ts`, `memory.ts` (`setAgentMemory`), `archive.ts`,
  `pins.ts`. `currentMemory` sits in `records.ts` (a read) so `publish.ts` and `memory.ts` do not
  import each other; `records.ts` imports nothing from the others.
- Shims re-export exactly the names the old files exported (explicit lists, no `export *`).
- Docs: no `docs/guide/` change: internal refactor, nothing a member, admin or agent sees.

## Open questions (for Chris or the coordinator)

- none; importers can move to the new modules gradually.

## Evidence (acceptance criteria → test or command output)

- ac-1: largest new file `threads/queries.ts` (614 lines); shims ~50 lines.
- ac-2: `vitest run -c vitest.db.config.ts` on agents, agent-versions, threads, threads-plans,
  thread-team-sharing, agent-roster-resolution db tests: 6 files, 141 tests passed;
  `team-filter.test.ts` passed; `pnpm --filter @kobe/server typecheck` clean.
- Pure move check: sorted non-blank lines of old vs new files differ only in imports and module
  doc comments.
