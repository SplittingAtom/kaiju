# KOBE-744: Flaky web run: Radix hover-card timer fires after teardown (draft-project.test.tsx)

- **Status:** in review (group 54, local commits)
- **Branch / worktree:** `group-54-web-chat` in `../Kobe-g54`
- **Depends on:** none

## Root cause (ac-1): inferred, not reproduced

- The only Radix HoverCard in the web app is the rail's thread card
  (`components/shell/rail-thread-card.tsx`: `HoverCard.Root openDelay={600} closeDelay={100}`),
  wrapped around every thread row in the rail. `draft-project.test.tsx` renders the whole chat
  (`openApp`) and user-event moves the pointer across rail rows (e.g. "Budget", "New
  conversation"), which starts the card's open/close `window.setTimeout`s.
- Radix clears those timers in its unmount effect, and the file calls `cleanup()`; vitest's
  happy-dom teardown also aborts the window's tracked timers. The CI stack shows the timer's
  callback (`setOpen`) running straight from a Node `Timeout` after the globals were removed, so a
  timer was pending past both: one scheduled while the tree was being torn down under load. It
  did not reproduce locally (an instrumented copy of the file showed no hover timer pending after
  `cleanup()` on an idle run), so the exact interleaving is inferred, not observed.

## Fix (ac-2, ac-3)

- `apps/web/vitest.setup.ts`: a shared `afterEach` for every DOM test file: `cleanup()` (unmount
  whatever is still mounted), then clear every `window.setTimeout` the test left pending (the
  setup wraps `window.setTimeout`/`clearTimeout` to track them; a fired or cleared timer leaves the
  set). It runs after each file's own `afterEach` hooks (vitest's stack order), so files that
  already clean up are unaffected, and it covers all siblings that render the rail (every
  `openApp` test) without per-file changes.
- No global suppression: no `onUnhandledError`/`dangerouslyIgnoreUnhandledErrors`; a timer that
  throws during its test still fails it.
- **Guide:** no user-facing change (test setup only): no docs/guide update.

## Evidence

- `draft-project.test.tsx` 30 consecutive single-file runs (separate vitest processes): 30/30
  exit 0, 11/11 tests, no unhandled error; 3 more runs after a type-only tidy of the setup.
- `components/shell` + `draft-project`: 36 files / 432 tests green; full web suite: 427 files / 3821
  tests green, no errors. Typecheck, lint, prettier green; the full `pnpm verify` runs once with
  the group's last commit (test setup only here).

## Review note (2026-11-21)

The failure was not reproduced locally, so the fix is a probable mitigation, not a confirmed
cure: the shared `afterEach` clears timers pending at the end of each test and unmounts before the
window goes away, but a timer scheduled during file teardown, after `afterEach`, could still fire.
If the unhandled `window is not defined` error shows up in CI again, reopen this ticket with the
run link rather than filing a new one. The setup replaces `window.setTimeout` with a wrapper;
where `window` is the global object that also replaces the global `setTimeout` and drops Node's
`promisify.custom` symbol, so a test using `promisify(setTimeout)` would need the real timer.
