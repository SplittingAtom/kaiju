# KOBE-724: Tests: replace fixed sleeps with condition waits / fake timers (web part)

- **Status:** in review (group 61, branch `group-61-web-splits-protocol`); the server-side files
  of this ticket are done on another branch
- **Branch / worktree:** `group-61-web-splits-protocol` in `../Kobe-g61`

## Decisions

No fixed `setTimeout` wait is left in `apps/web/components/shell/rail-tabs.test.tsx`,
`apps/web/components/shell/rail-pickers.test.tsx` or `apps/web/components/apps/app-context.test.tsx`:

- A sleep before a "nothing happened" check waits instead for the state that ends the decision:
  the rail's `data-settled` (stored tab and picker applied), an app frame's bridge attached (its
  opening done), the picker frame on screen, the insert marker shown, the Files region unhidden
  once the apps list is read.
- A sleep after a key press or click is `act(async () => {})` (React work and microtasks
  flushed) plus a check that the composer still holds its text (a send would have cleared it).
- The debounced-save check no longer waits 900 ms: a later change must arrive as the second
  save, so a second save queued by the burst would fail it.
- The insert settle time (`INSERT_SETTLE_MS`, read from `Date.now()`) uses a faked `Date`
  (`vi.useFakeTimers({ toFake: ["Date"] })`, timers stay real) and `vi.setSystemTime`, instead
  of an 800 ms real wait; "a reflex keystroke right after the insert" is now exact.
- User-facing docs: none needed (tests only).

## Evidence

- ac-1: `grep -n setTimeout` finds nothing in the three files.
- ac-2: each file passed 20 consecutive single-file runs
  (`for i in $(seq 20); do pnpm --filter @kobe/web exec vitest run <file> || break; done`).
