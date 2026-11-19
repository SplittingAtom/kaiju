# KOBE-663: Learn spec: composer missing after closing To review (intermittent on gate1)

- **Status:** in review (local commit, not pushed)
- **Branch / worktree:** `kobe-663-sm` in `../Kobe-wt663`
- **Depends on:** KOBE-395, KOBE-396, KOBE-661

## Root cause (spec, not app)

A race in `e2e/browser/tests/learn-from-chat.spec.ts`. Not the history step counting, the inert
chat or the Close button:

- When a pass ends, `useLearn` sets the + to `count`, writes "Kobe found 1 thing to review…" in the
  notice, and announces the pass; `useReviewArrival` then calls the router's `push("/me/memory?review=1")`.
  The panel only appears once Next has loaded that route (RSC request, the page's chunks), a
  moment **after** the + has settled.
- The spec polled "panel visible, or + no longer spinning". When its poll saw the + settled before
  the panel arrived, it took the "nothing opened" branch (the notice matched `Kobe found`), went on
  to `chat.composer.click()`, and To review opened under it: the chat went inert, so
  `getByRole("textbox", { name: "Message" })` never resolved, with the page at
  `/me/memory?review=1`. The gate run's "Close hid the panel" was a reading of the assertions; in
  the failing path Close was never clicked.
- Checked and ruled out on gate1 (instrumented runs): history entries were `/`, `/?thread=…`,
  `/me/memory?review=1`, origin index 1, Close went back one step to the thread; afterwards no
  element outside the steering panel stayed inert, no panel or dialog, composer present. The
  panel's first `/^Close /` button is its header's "Close My memory".

A person can't hit a failure here: To review opening a moment after the notice is the designed
behaviour (KOBE-396), so no app change.

## Fix

- The spec waits for the notice's ended sentence (what the pass found or why it stopped) and lets
  that decide: "Kobe found N thing(s) to review" waits for the panel to open, checks the URL,
  closes it with "Close My memory" and checks the + count; otherwise the panel stays hidden and the
  - no longer spins.
- The message carries a preference new to the member on each run (tea, minutes and seconds from
  the clock), so every pass finds a candidate and To review's branch always runs. Candidates stay
  in To review with the thread, which the fixture moves to Trash; nothing is saved.

## Decisions

- Spec-only fix; no unit test (no app change).
- Guide: no change. Nothing a member, admin or agent sees changed (spec only).

## Evidence

- ac-1 (cause, trace of a failing run): copy of the old spec with a fresh preference, the
  `/me/memory` route delayed 2.5 s and a 3 s pause before the composer step (to widen the race
  window deterministically): timeline `13617 plus=count`, `16247 panel=true`; spec took the
  no-panel branch and failed at `chat.composer.click()` with "waiting for getByRole('textbox',
  { name: 'Message' })", page URL `/me/memory?review=1`, chat inert — the gate failure exactly.
  Without the pause the same delayed run passed only because the spec finished before the panel
  came. The fixed spec with the same 2.5 s delay passed.
- ac-2: the committed spec as member2 on gate1 (main deployed), 10 runs in a row, 10 passed; each
  pass found a candidate ("Kobe found 1 thing to review"), To review opened by itself and closed.
  Passes spent today by this ticket: 14 (2 diagnosis, 1 delayed old spec, 1 delayed fixed spec, 10).
