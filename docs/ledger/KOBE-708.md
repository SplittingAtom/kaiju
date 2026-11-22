# KOBE-708: Split runs/orchestrator.ts and make its late-wired dependencies required

- **Status:** in review (group 65, branch `group-65-orchestrator-composition`)
- **Branch / worktree:** `group-65-orchestrator-composition` in `../Kobe-g65`
- **Depends on:** none (KOBE-709 follows on the same branch)

## Plan

Review 2026-11-20 CODE-4 (split) and CODE-28 (required dependencies). `DbRunOrchestrator` stays
the facade (`ServerRunOrchestrator` minus the `use*` setters); its parts move to
`services/server/src/runs/orchestrator/`:

| File              | Holds                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator.ts` | facade: steer, cancel, reads, compaction/notebook hosts, wire end, sweep, close                                                           |
| `options.ts`      | `RunTuning`, `RUN_DEFAULTS`, `RunOrchestratorOptions` (re-exported by the facade)                                                         |
| `contract.ts`     | `ServerRunOrchestrator` (re-exported by the facade)                                                                                       |
| `core.ts`         | `RunCore`: shared state, `threadTx`/`readTx`, `assertMayRun`, promotion, the one transition bus (`emit`/`notify`), `advance`, `withRetry` |
| `submit.ts`       | `submitMessage`, attachment staging, viewed file, `submitInTx`                                                                            |
| `queue.ts`        | `updateQueued`, `retry`, `resumeQueue`, `reorderQueue`, `pauseQueue`                                                                      |
| `budget-stop.ts`  | `stopForBudget`, `markSandboxLost`                                                                                                        |
| `workspace.ts`    | `RunWorkspace` seam (attachments, viewed file) and its slot                                                                               |

## Decisions

- **Isolation probe is required, no default.** `RunOrchestratorOptions.isolation` and
  `ServerDepsOptions.isolation` are required; `index.ts` creates the isolation gate before the
  dependencies (its audit is bound once the database exists, before `isolation.start()`).
  Tests pass `fakeIsolation()` from `testing/isolation.ts`; the harness and the event-stream
  fixture give each replica one (`replica.isolation.set(...)`).
- **`checking` refuses** (ac-3): new runs, retries, compaction, branch summaries and notebook
  runs/starts start only while the probe answers `available`; `checking` and `missing` are
  `isolation_unavailable` (503). `checking` lasts only until the startup check settles; the
  scheduler retries a refused occurrence on its next tick (unchanged behaviour for `missing`).
- **Notebooks** are passed at construction (`notebooks: NotebookFiles`); the file store itself
  is still bound to workspace sync later (`notebookFiles.use`), as before.
- **Attachments and the viewed file** need workspace sync, which `index.ts` builds after the
  dependencies (it needs their database). The orchestrator takes a required `RunWorkspace`
  seam read at call time; `deps.runWorkspace.use({ attachments, viewing })` binds it, like
  `projectMounts.use` / `notebookFiles.use`. Unbound it fails closed (`attachments_unavailable`;
  viewed file path only), exactly as an unset setter did.
- Pure move otherwise: method bodies unchanged except `this.#x` → `core.x`.

## Docs

No `docs/guide/` change: nothing a member, admin or agent sees changes. The only visible
difference is that a message sent in the seconds while a fresh pod's isolation check is still
running is refused with the existing `isolation_unavailable` message instead of starting (pods
are not ready before that check settles).

## Evidence (acceptance criteria → test or command output)

- ac-1: `wc -l` orchestrator.ts 512; parts ≤ 363 lines. Exports from `runs/index.ts` and
  `runs/orchestrator.ts` unchanged (plus `createRunWorkspace` and its types).
- ac-2: no `use*` on `ServerRunOrchestrator`; `isolation` required (typecheck fails without it).
- ac-3: `runs.db.test.ts` "refuses new runs while the isolation runtime is missing/checking".
- ac-4: `vitest -c vitest.db.config.ts` runs, runs-review, runs-attachments, file-viewing,
  approvals-retry, budgets, notebooks, runs-queue-pause, thread-compact, runs-interrupted:
  10 files, 117 tests passed. Unit `src/runs src/notebooks src/startup`: 72 passed.
