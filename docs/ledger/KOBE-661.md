# KOBE-661: Learn pass completion does not reach the browser (spinner stays) on a 2-replica install

- **Status:** in review (local commit, not pushed)
- **Branch / worktree:** `kobe-661-sm` in `../Kobe-wt661`
- **Depends on:** KOBE-395, KOBE-396, KOBE-398

## Root cause

Not a cross-replica signal. The + button never listens to an in-process event: it polls
`GET /v1/threads/{id}/learn` every 2 s, and that answer comes from Postgres
(`memory/learn/state.ts`), so either replica gives the same answer. Checked on gate1 (both pods
answer `running: null, candidates: 1` for the pass d2abb721).

Reproduced on gate1 with an instrumented copy of the spec (each `/learn` request and response,
navigations, the React state behind the +):

- When the pass finds **0** candidates, the + settles and the spec passes.
- When it finds **1 or more**, `useLearn` announces the pass and KOBE-396 opens To review by
  itself (`/me/memory?review=1`). That is a modal panel, and the chat behind it is inert, so the +
  leaves the accessibility tree. The spec's `getByRole('button', {name: 'Add to your message'})`
  then finds nothing ("Received: element(s) not found" after 8 resolutions showing the spinner),
  and `not.toHaveAttribute("spinner")` times out. In the DOM the + already shows `count`.

The gate run got 1 candidate, so it hit the second case. The spec did not cover KOBE-396's
auto-open.

## Fix

- `e2e/browser/tests/learn-from-chat.spec.ts`: the pass ends one of two ways. Either To review
  opens by itself (check the URL, close it, the + shows the count), or the + settles and the
  notice says how it went.
- Web hardening (`apps/web/lib/chat/learn-watch.ts`, the pure state machine, used by
  `components/chat/use-learn.ts`):
  - never spins forever: once a pass has been watched for longer than `MEMORY_PASS_MAX_MS` + 15 s,
    the + stops spinning and says "Try again". A pass given up on doesn't bring the spinner back;
  - reads the state again when the tab becomes visible or the network comes back while a pass runs;
  - a read sent before a start (for example the submenu's estimate) can no longer end the pass
    that start began (an epoch counter).
- Guide: `docs/guide/memory.md` (To review opens by itself; the spinner stops after a few minutes).

## Decisions

- No LISTEN/NOTIFY channel added: the durable state is already read from Postgres on every poll,
  which is cross-replica by design. The pass's `memory.pass.completed` run event is written in the
  same transaction, but the run's SSE stream ends at `run.completed`, so the web doesn't use it.

## Evidence

- ac-1: `services/server/src/memory-learn-route.db.test.ts` "a pass that ran on another replica
  (KOBE-661)": two replicas on one database. The pass is started and run on replica 0, held
  running by the gateway stand-in. Replica 1 sees it running, then completed (`running: null`,
  1 candidate, no dot), along with the bell's `memory.review.candidates_ready` notice. 12/12 pass.
- Web: `lib/chat/learn-watch.test.ts` (9 state-machine cases); `components/chat/plus-learn.test.tsx`
  adds the timeout ("Try again", no spinner) and the read on visibility. Both fail on the old hook
  and pass on the new one.
- ac-2: the updated spec passed on gate1 (current image ee806045) three times with 0 candidates
  (owner) and once with 2 candidates, To review opening by itself (member2, varied prompt). The
  owner's 20 passes a day on gate1 were used up by the diagnosis runs on 2026-11-16.
