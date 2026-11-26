# KOBE-846: Context panel layout: full-height vertical gauge between the list and a right rail

- **Status:** in review (committed on the branch; coordinator pushes and opens the PR)
- **Branch / worktree:** `group-148-context-layout` in `../Kobe-g148`
- **Depends on:** KOBE-841 (legend filter), KOBE-842 (conversation stats), KOBE-471 (viewer)

## Plan

Web only, no server, protocol or token change. `context-stack.tsx` splits the old `ContextStack`
(bar and legend side by side) into `ContextBar` (the middle column) and `ContextTotals` (the
legend, now the top of the rail); `ContextViewer` lays out text | gauge | rail; the CSS module
moves from a flex `.side` column to a three-column grid.

## Decisions

- **Columns.** `grid-template-columns: minmax(0, 2fr) 1.75rem minmax(16rem, 1fr)`, one row of
  `minmax(0, 1fr)`, so the gauge column stretches the panel's full height and the text keeps two
  thirds of the remaining width. The rail never drops below 16rem (legend rows and the stats'
  term/value grid stay readable); the text column is the one that gives way.
- **Gauge.** `flex-direction: column` (was `column-reverse`): segments top to bottom in the order
  of the totals list (`model.slices`), free space last, so it is the bottom segment, just as Free
  is the last row of the totals. Heights are `flex: 0 1 var(--share)` (share of the window); free
  takes the rest. The free segment now has its own tooltip ("Free: 11k tokens").
- **Accessibility.** The bar was `aria-hidden` with no text equivalent; it is now wrapped in a
  `role="img"` whose name says the use, the window and the free space and points to "Context by
  kind" (the totals list, which carries every figure and the keyboard filter). The segments stay
  `tabIndex=-1` pointer shortcuts inside the hidden bar. Filter highlight (`data-filtered` on the
  gauge, outlined selected segment, the others faded), keyboard toggles and Clear filter unchanged.
- **Rail.** `role="region"` "Totals and stats", `tabIndex=0` so the keyboard can scroll it (this
  also closes the KOBE-842 review's "stats box not keyboard-scrollable" note); the stats lose
  their own scroll and max-height, the rail scrolls them with the totals. When the context cannot
  be read, the stats render alone in the same rail.
- **Narrow layout (under 720 px; was 640 px, raised so the text column keeps about 390 px beside
  a 16rem rail).** The chosen order from the brief: gauge horizontal on top (free at the end),
  totals, stats, then the text at `max(16rem, 70dvh)`; the columns area scrolls as one. Done with
  CSS `order`, so the DOM (and tab) order stays text, gauge, rail, matching the wide layout.
- **Theme.** Existing tokens only (`--kaiju-console-control-border`, `--background`,
  `--kaiju-composer-focus`, the `--kaiju-ctx-*` kinds), which have light, chosen-dark and OS-dark
  values; no new tokens.

## Docs evaluation

Member-visible change, guide updated in this PR: `docs/guide/chat/context-panel.md` "The two
sides" becomes "The layout" (three columns, gauge order and free space at the bottom, rail
scrolling, phone order), and the filter, memory and stats sections say "totals list" / "right
column" instead of "the gauge's list". Spec note "Layout (KOBE-846)" in
`docs/specs/context-viewer.md`. No "For agents" change: agents in the sandbox never see the
panel. No UI label renamed except the new rail region name.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/shell/context-layout.test.tsx` "has three columns" (DOM order
  text, gauge, rail) and the CSS checks (grid columns, one stretched row, bar `flex: 1 1 auto`);
  browser spec: gauge between text and rail, height over 95% of the columns and over 4× its width.
- ac-2: layout test (rail region, totals then stats, scrolls on its own); `context-stats.test.tsx`
  "sits in the right rail under the totals"; browser spec (rail holds both).
- ac-3: layout test "stacks the used kinds in the totals' order, free space the bottom segment"
  (segment order, shares, free last, CSS `column` not `column-reverse`); browser spec (segment
  order matches the totals, free segment's bottom at the bar's bottom).
- ac-4: layout test filter highlight + Enter toggle, gauge `img` with text equivalent, narrow CSS
  order; existing `context-panel.test.tsx` / `context-viewer.test.tsx` filter tests unchanged and
  green; browser spec at 390 px (gauge horizontal, then totals, stats, text, nothing wider than
  the viewport); guide updated.
- Browser spec: run against gate1, which still serves the old layout until this is deployed, so
  it is expected to fail at the new layout checks; the run only shows the spec compiles and runs
  (result in the report / commit).
