# KOBE-713: sandbox-agent splits: workspace/sync.ts, threads/thread.ts, agent.ts, threads/manager.ts; lstat treats only ENOENT as missing (review CODE-7-25)

- **Status:** in review (group 53, local commits; coordinator pushes)
- **Branch / worktree:** `group-53-sandbox-agent` in `../Kobe-g53`
- **Depends on:** KOBE-712 (agent.ts wires the brokers)

## Plan

One pure-move commit per file (review SPLIT-7), then one commit for CODE-25 and the orphaned
capability JSDoc. Lines (origin/main → now): `workspace/sync.ts` 1216 → 312, `threads/thread.ts`
1209 → 670, `agent.ts` 1086 → 784, `threads/manager.ts` 1076 → 726. Largest new file:
`workspace/sync/push.ts` 355.

- sync.ts: class keeps scheduling; `workspace/sync/{types,state,move-replay,local,restore,pull,push}.ts`
  are functions over one `SyncState` the class owns. Public types live in `sync/types.ts` and are
  re-exported from `sync.ts` so its ~20 importers (tests included) are unchanged.
- thread.ts: `threads/{thread-env,spawn,runtime-check,reclaim,dialogs,branch-summary-state}.ts`.
  Thread state reaches them through explicit ports (`SpawnCallbacks`, `RuntimeFiles` getters,
  `UiRequestPort`); `BranchSummaryState` is a small class holding the armed summary.
  `manager.ts` and `notebook/launcher.ts` import `ThreadEnv`/`ThreadHooks`/`SHARED_SCRATCH_DIRS`
  from `thread-env.ts`.
- agent.ts: `agent/{deps,capabilities,wiring}.ts` (`capabilitiesOf(deps)`, `helloCapabilities`,
  `createToolBrokers`, `routeToolsRequest`, `routeToolResult`). `AgentDeps`/`WorkspaceHooks` are
  re-exported from `agent.ts` (index.ts, harness, one test import them).
- manager.ts: `threads/{compaction,session-commands,manager-options,manager-util}.ts` over a
  `ManagerPort` the class builds.
- No import cycles among the new modules (checked with a script over the import graph; madge is
  not installed). The only cycles in the package are the pre-existing ones in `kobe-tools/`.

## Decisions

- `RuntimeFiles` passes getters, not a snapshot, so the tamper check reads each file as the
  original did after every await.
- Capability predicates are recomputed on each use (`#caps()`), as the methods were.
- CODE-25: `lstatIfExists` (workspace/fs.ts) returns undefined only on ENOENT/ENOTDIR and is used
  at the 12 listed sites (fs.ts ×7, moves.ts ×5). Not changed: `tools/skill-draft-broker.ts`
  `folderDir` has the same `lstat().catch` pattern (answers `not_found`); left for a follow-up.
- Orphaned JSDoc: the `save_skill_draft` comment now sits on `skillDraftsEnabled`; the
  `share_file` comment (also orphaned, above `#syncNow`) landed on `filesEnabled` with the move.
- No docs/guide change: internal refactor plus an error-handling fix nobody sees unless a file is
  unreadable to the agent (then sync logs a failure instead of treating it as gone).

## Evidence (acceptance criteria → test or command output)

- ac-1: line counts above (all four under 800).
- ac-2: `src/workspace/fs.test.ts` "treats only ENOENT/ENOTDIR as missing, never an unreadable
  directory" (skipped as root); fails against the old catch-all behaviour.
- ac-3: `pnpm --filter @kobe/sandbox-agent test`: before 1342 tests (after KOBE-712), after 1343
  (1146 passed, 195 skipped, 2 environmental failures in `models/runtime-dir.test.ts` under the
  group-writable `~/.kobe-coord` TMPDIR; they pass with `TMPDIR=/tmp` and under `pnpm verify`).
  `agent.runs`, `sync`, `manager`, `tripwire-race`, all broker tests green, unchanged.
  `identities.real.test.ts` needs root + Pi identities (CI `test-identities.sh`); skipped here.
