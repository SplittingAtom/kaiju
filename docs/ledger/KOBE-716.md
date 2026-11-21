# KOBE-716: Web chat: split thread-controller.ts, tree.ts, chat-app.tsx (review CODE-10)

- **Status:** in review (group 54, local commits)
- **Branch / worktree:** `group-54-web-chat` in `../Kobe-g54`
- **Depends on:** none (KOBE-717 follows on the same branch)

## Plan

One commit per file split, no behaviour change; existing tests unchanged.

- `lib/chat/thread-controller.ts` (1361 → 794): pure planners in `lib/chat/thread-controller/`
  (`after-close.ts`: what a stream signal, a close before the terminal event and a terminal event
  lead to; `history.ts`: runs/pending folded into the state, where a run's history ends, live file
  events, the thread read with its entry pages; `queue.ts`: queue order and positions;
  `model-restore.ts`: regenerate's model switch and the failure kept) and the actions behind a
  narrow `ControllerPort` (`port.ts`: state, set, busy, fail, announce, refresh, leaf version):
  `queue.ts`, `settings.ts`, `branches.ts`, `send.ts`. The class keeps `#set`, the stream
  open/close/reconnect, the event handling and every public method (as one-line delegations).
- `lib/chat/tree.ts` (880 → 40; modules 67-287 each): `lib/chat/projection/` (`types.ts`, `build-nodes.ts`,
  `project.ts`, `branch-point.ts`, `overlay.ts`); `tree.ts` keeps the module doc and re-exports
  the same public names.
- `components/chat/chat-app.tsx` (636 → 183; `chat-workspace.tsx` 315): `ChatApp` only. `ChatWorkspace` (with its grid
  and starter prompts) to `chat-workspace.tsx`; `useThreadUrl` (+ `threadFromUrl`,
  `openThreadInChat`), `useHistoryRoute` (+ `WorkspaceRoute`, re-exported from `chat-app.tsx` for
  `workspace-host.tsx`) and `useActiveTeam` to `lib/chat/use-*.ts`; the four identical
  `runtime.threads.reload()` subscriptions to one hook.

## Decisions

- **Hook name:** `useThreadListReload` (`lib/chat/use-thread-list-reload.ts`), not the review's
  `useThreadListSync`: `ThreadListSync` already names the cross-tab BroadcastChannel
  (`thread-list-sync.ts`), which is one of the hook's four sources. One effect, same four
  subscriptions in the same order, same `[session, runtime]` dependencies, all four unsubscribed
  in its cleanup.
- **Bar menu reset kept as an effect.** `useEffect(() => setBarMenuOpen(false), [threadId, …])`
  closes a menu whose state lives in `ShellSlotsProvider` (above the workspace, shared with the
  utility bar), not in `ChatWorkspace`; it also runs on mount. Keyed state would need that
  provider to know the thread (or the menu state to move), which is not provably identical, so it
  stays as is.
- **Planner seams:** the review's line ranges were from an older commit (`#afterClose` is now 25
  lines); the planners cover what the after-close path decides today: re-read the history (ended
  run), re-read when the run went back to the queue (the read promotes the next), reopen with
  backoff or give up, the terminal event's leaf move / announcement / epilogue, plus the model
  restore and queue planners. Tests in `lib/chat/thread-controller/planners.test.ts` need no
  FakeKobe.
- **Port:** one object built in the constructor; `SendPort` adds what sending needs (keys, own
  runs, starting the stream). The private fields stay private.
- **Guide:** no user-facing change (internal refactor): no docs/guide update.

## Open questions (for Chris or the coordinator)

- ac-3's gate1 browser check is for after the deploy (coordinator).

## Evidence (acceptance criteria → test or command output)

- ac-1: line counts above; `chat-app.tsx` holds `ChatApp` and its props only.
- ac-2: `planners.test.ts` (after-close, signal, terminal, model restore, queue and history
  planners), 19 tests.
- ac-3: `conversation`, `thread-controller*`, `tree*`, `chat-app*` and every other web test pass
  unchanged (no test file edited). Web tests: 426 files / 3817 tests before (origin/main);
  428 files / 3840 tests (incl. the 19 planner tests and KOBE-719's 4) after.
- `pnpm verify` green before the last KOBE-716 commit.
