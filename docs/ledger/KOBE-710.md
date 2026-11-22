# KOBE-710: Split sandbox/provider.ts into provider/\* parts (review CODE-5)

- **Status:** in review (group 72, branch `group-72-volume-lost-provider-split`)
- **Branch / worktree:** `group-72-volume-lost-provider-split` in `../Kobe-g72`
- **Depends on:** KOBE-739 (same branch, the commit before: its `volumeHealth`/`discardLostVolume`
  were moved too)

## Plan

Pure move of the 1310-line `createSandboxProvider` closure (after KOBE-739) into factories over a
shared `ProviderContext`; `provider.ts` composes them and re-exports every public name.

## Decisions

- Parts (`services/server/src/sandbox/provider/`), each a factory `createXOps(ctx, deps)`:
  `context.ts` (options destructuring, `emit`, `endpointAddresses`, `stillVerified`,
  `deleteWithRetry`, `rejectAndDelete`, `POD_WAIT_TIMEOUT_MS`, `READY_TIMEOUT_MS`), `team.ts`
  (admission self-check, the `ensured` cache, `applyWithRbacRetry`, converge/ensure/reconcile
  teams), `claims.ts` (claim, resume, provision, wake, hibernate), `readiness.ts` (`awaitReady`),
  `volumes.ts` (destroy, volume delete, terminating wait, KOBE-739 lost volumes),
  `identity.ts`, `isolation.ts` (reconciler, `isLive`), `eval-sandboxes.ts`, `errors.ts`,
  `kube-objects.ts` (`ref`/`CLAIM`/…/`field`/`str`, `workspacePvcName`), `types.ts`.
- Shared mutable state stays single: `ensured` and `admissionVerified` live inside the one
  `createTeamOps` call per provider; `claims` gets `ensureTeam` and `untilVolumeNotTerminating`,
  `eval-sandboxes` gets `provision`, passed in by `createSandboxProvider`.
- Every function body moved verbatim (checked by script: all 37 closure items found unchanged in
  the new files); only the per-factory `const { … } = ctx` lines are new.
- `provider.ts` is 85 lines; parts 42–339 lines (largest `claims.ts`; `types.ts` 236).
- `provider.test.ts` (967) split along the same lines into `provider-{team,claims,identity,
isolation,eval}.test.ts` with the shared setup in `testing/provider-setup.ts`; 61 tests, as before.
- No behaviour change, so no guide or install change.

## Open questions (for Chris or the coordinator)

- ac-3 (k3d e2e shard on the group PR) runs in CI only.

## Evidence (acceptance criteria → test or command output)

- ac-1: `wc -l` above (provider.ts 85, no part over 800).
- ac-2: `src/sandbox` unit tests 437 passed / 4 skipped before and after the move (61 of them the
  former provider.test.ts); `sandbox-lifecycle.db.test.ts` in `test:db`.
