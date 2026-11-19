# KOBE-654: MCP-UI badge tooltip does not open on keyboard focus

- **Status:** committed locally, not pushed
- **Branch / worktree:** `kobe-654-badge-tooltip` in `../Kobe-wt654`
- **Depends on:** KOBE-640

## Plan

Reproduce in real Chromium, fix the cause once in the shared tooltip wrapper, restore the keyboard check.

## Decisions

- **Cause (reproduced in Chromium 1228, Playwright):** Tab to a badge that is scrolled out of view makes the
  browser scroll it in. Radix Tooltip closes on any `scroll` (capture, window) whose target contains the
  trigger, so the tooltip that focus opened closed again within a frame. Hover is unaffected (Playwright
  and real pointers scroll first, then arrive). A badge already in view kept its tooltip. happy-dom never
  scrolls, hence the green unit test. Not an `asChild`, ref or `onFocus` problem.
- **Fix:** `components/ui/tooltip.tsx` `Tooltip` is controlled and ignores a close request that a scroll
  caused within 300 ms of the trigger's focus while that trigger still has focus. Escape, blur and pointer
  leave still close. `TooltipTrigger` feeds the guard. All shared wrappers (icon-action, rail-team,
  context-gauge) get it; `McpUiBadge` now uses the shared `Tooltip`/`TooltipTrigger` (it used raw Radix).
- Other raw Radix Tooltip uses in the app: none (grep).

## Evidence

- ac-1: standalone Chromium repro (focus-scrolled trigger): before 0 tooltips, after 1; Escape closes,
  re-Tab reopens (repro kept outside the repo). Firefox not run locally.
- ac-2: `e2e/browser/tests/connector-panels.spec.ts` now hovers, leaves, then Tabs to the badge and
  presses Escape; to be run on gate1 after deploy.
- ac-3: shared wrapper, see above. Unit test `components/ui/tooltip.test.tsx`.
- Docs: none needed (keyboard behaviour fix, no UI label or flow change).
