# KOBE-845: KOBE-840 follow-up: composer focus and Learn-dot browser specs fail on the test install

- **Status:** in review (branch committed, not pushed)
- **Branch / worktree:** `group-147-kobe-840-followup` in `../Kobe-g147`
- **Depends on:** KOBE-840 (merged)

## Plan

Two specs from KOBE-840 passed in CI but failed on gate1 (local-c1e52e05d372, real model). Find
whether each failure is a spec assumption or a product bug, fix it, run both specs on gate1
before and after.

## Decisions

1. **composer-focus.spec.ts:60 — spec bug.** With the command palette (a Radix modal) open, the
   page behind it is hidden from the accessibility tree, so `chat.composer`
   (`getByRole("textbox", { name: "Message" })`) finds no element and `not.toBeFocused()` fails
   on "element(s) not found". The palette step was also conditional (`if (count > 0)`, read right
   after the key press), so it could skip silently. Now it opens the palette unconditionally,
   expects the palette's combobox to have the focus (again after 500 ms, longer than the
   composer's two-frame request), checks `document.activeElement` is not inside
   `[data-kaiju-composer]`, then Escape closes the palette and the composer has the focus again
   (the palette's `onCloseAutoFocus` returns it to the element focused before it opened).
2. **memory-quality-nudge.spec.ts:232 — spec assumption, not a product bug.** Code path read:
   the pulse (`useLearnNudge`) runs only while `plusIndicator(...).mark === "dot"`, and the dot
   needs `memoryDotAllowed(percent)`, i.e. a known figure strictly above 30 (null → no dot); the
   figure is `useThreadContextPercent()`, the gauge's own reading. Nothing claims the nudge before
   the gate. The spec answered `GET /v1/team/models` with a 100k window, but while a run streams
   (and after it, since the faked `latest_call` never matches the live run id) the figure is the
   run's own streamed prompt size, which on gate1 is about 62k tokens from the first turn (system
   prompt, tools, memories): 62% of the faked window, so the dot and pulse were correct. Fix: the
   faked window is now 10M tokens, so a real run reads under 1% and only the spec's stored
   figures (exactly 30%, then 31%) decide; after each of the ten runs the spec reads the meter and
   asserts the figure shown is at or below 30% (checked, not assumed), and logs it. The 30%/31%
   steps and the correction pulse are unchanged.

## Docs evaluation

No guide change: only browser specs changed; nothing a member, admin or in-sandbox agent sees or
can do is different.

## Evidence (acceptance criteria → test or command output)

- ac-1: gate1 runs of both specs with `~/.kobe-coord/browser-gate1.sh`. Before (unmodified
  specs at c1e52e05d): 2 failed, 3 passed, the same two failures as the evidence log. After: 5 passed (2.0 m); runs 1–10 showed
  0.624%–0.656% (62,366–65,629 tokens of the 10M window).
- ac-2: not applicable — no product bug (decision 2); no product code changed.
- Checks (`TMPDIR=~/tmp`): `e2e/browser` tsc, eslint and prettier on both specs, repo
  `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, rename guard ok. Web unit suite not run (no
  product code changed).
