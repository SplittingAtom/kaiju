# KOBE-843: My memory and My schedules in the profile menu; an icon for every profile menu item

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `group-145-profile-menu` in `../Kobe-g145`
- **Depends on:** none

## Plan

Move the two bar icons into the profile (avatar) menu, give every menu item a lucide icon, keep
routes, `/` words and palette entries, update tests, browser specs and the guide.

## Decisions

- **Registry scope.** `my-memory` and `my-schedules` keep their registry entries (name, icon,
  href, `/memory` and `/schedules`) with a new scope `profile-menu` instead of `bar` + group
  `areas`. The bar's My area nav reads `commandsIn("bar")`, so it now shows only Agents and Skills;
  the palette and `/` menu list commands by href/slash, not scope, so both still open the pages.
  `IconAction command="my-memory"` (Open in Memory chip) is unaffected.
- **Icons.** My memory and My schedules take the registry's own icons (`BrainIcon`,
  `CalendarClockIcon`) through `command(id).icon`, so the two can't drift. The others: Projects
  `FolderKanbanIcon` (the registry's project icon), My connectors `PlugIcon` (the + menu's
  connectors), My approvals `ShieldCheckIcon` (the approval marker), My shared cases
  `FlaskConicalIcon` (eval cases), Sign-in methods `KeyRoundIcon` (sign-in form), Sign out
  `LogOutIcon`. All `size-4 shrink-0`, `aria-hidden`, before the name; items are flex rows with a
  0.5rem gap.
- **`MenuLink` requires an `icon`** (type-level), so a new menu link can't land without one.
  Menu links are data (`PROFILE_LINKS`) rendered in order: Projects, My memory, My schedules, My
  connectors, My approvals, My shared cases, Sign-in methods, then Sign out.
- **Badges.** Neither bar button carried a badge or count (they were plain registry
  `IconAction`s in `AreaLinks`; the learn dot and memory suggestion count are on the composer's +
  button, schedule failures arrive as notifications). Nothing to move, so no avatar dot was added;
  adding a dot with no source would be dead code.
- **Layout.** Two fewer icons in the bar's actions row; no other change to the bar. Keyboard order
  is now: search, Agents, Skills, (Site console), Notifications, Docs, Dark theme, Profile. Under
  768 px the profile menu sits in the bar's Menu as before; the menu list is absolutely
  positioned with `min-width: 12rem` and the icons fit inside it.

## Docs evaluation

Members see a change (where the two pages are), so the guide changes in this PR:
`getting-started/layout.md` (top bar and Profile lists), `memory.md` (where My memory is),
`agents/agents.md` (where My schedules is), `whats-new.md` (a short note). The For-agents pages
don't mention the bar. The v1.3 release note's "memory icon in the top bar" is left as history.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `shell.test.tsx` "row one" (My area = Agents, Skills; menu has My memory and My
  schedules; no `my-memory`/`my-schedules` command in the bar); `profile-menu.test.tsx` "lists My
  memory and My schedules with the icons they had in the bar".
- ac-2: `profile-menu.test.tsx` "gives every item one decorative icon" (every `li`, Sign out
  included: one `svg`, `aria-hidden`, `size-4`, first child) and "keeps the icon out of each
  item's accessible name".
- ac-3: routes asserted in the same tests; `command-palette.test.tsx` and `slash` tests unchanged
  and green. No badges existed (see Decisions).
- ac-4: browser specs `my-area-panels.spec.ts`, `gate5/u18-never-lose.spec.ts`,
  `gate7/u51-notes.spec.ts` open the pages from the profile menu (not run against gate1 here);
  guide updated.
- Checks (TMPDIR=~/tmp, one at a time): build, typecheck, lint, format:check, web unit suite,
  theme guard (`console-css-guard`, `theme-css`), site wording, public hygiene, rename guard.
