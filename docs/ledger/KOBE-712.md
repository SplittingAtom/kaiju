# KOBE-712: sandbox-agent: one PendingRequests tracker for the eight tool brokers (review CODE-21)

- **Status:** in review (group 53, local commits; coordinator pushes)
- **Branch / worktree:** `group-53-sandbox-agent` in `../Kobe-g53`
- **Depends on:** none

## Plan

`tools/pending-requests.ts` `PendingRequests` (caps, id minting, `add`/`has`/`take`/`fail`,
`failAll`/`failRun`/`failThread`); each broker keeps its request-to-frame mapping, its "no active
run" check, its own cap message, and its exported `MAX_PENDING_*` caps and id prefix unchanged.

## Decisions

- No `Extra` type parameter: no broker stores anything beyond thread, run, extension id and reply.
- `ArtifactBroker` too-large: the id is now registered before the size check and failed with the
  same `too_large` answer; the id counter advanced in the same place before, so ids are unchanged.
- Synchronous brokers register before building the frame (was: after); nothing can observe the
  difference (no await between, one reply either way).
- No docs/guide change: internal refactor, nothing a member, admin or agent sees changes.

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/tools/pending-requests.test.ts` (7 tests: id minting, per-thread cap, global cap,
  double answer ignored, `fail` once, fail by run/thread/all, re-entrant fail).
- ac-2: all eight `*-broker.ts` use it; `src/tools` + `agent.wire.test.ts` 106 passed, existing
  tests unchanged.
- Package tests before: 1335 (1138 passed, 195 skipped, 2 failed); after: 1342 (1145 passed,
  195 skipped, 2 failed). The 2 failures are `models/runtime-dir.test.ts` and environmental: the
  required `TMPDIR` sits under a group-writable `~/.kobe-coord`, which the runtime-dir check
  rightly refuses; they pass with `TMPDIR=/tmp`.
