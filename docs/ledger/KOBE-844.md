# KOBE-844: Workspaces rail tidy-up

- **Status:** done, in review
- **Branch / worktree:** `group-146-workspaces-rail` in `../Kobe-g146`
- **Migrations / endpoints:** none (the stored view stays `rail_tab`).

## Decisions

- **Chris, 2026-11-25: the Apps view opens from Browse apps.** The first pass held item 1: the
  Files | Apps tabs (`rail-tabs.tsx`) were the only way into the rail's Apps view (the Pickers
  section). Chris decided: a **Browse apps** item in the composer's + menu next to **Apps**, a
  palette entry and a key; then both tabs go.
- **Key: Mod+Shift+X.** Free in the registry (taken: Mod+K, N, B, /, ., [, ], Mod+Shift+F, A, D,
  E, L, O, Enter; editor Mod+S/F/G); avoids browser keys (Ctrl+Shift+P/O/N/T/I/J/K/M/H/Y) and GTK's
  Ctrl+Shift+U. Listed in the `?` sheet's own Apps section (`APP_SHORTCUTS`).
- **Way back to Files from Apps:** a **Show files** icon in the Apps view's own heading row (the
  registry's `show-files`), besides Mod+Shift+F, `/files` and the palette. Without it a mouse user
  in Apps had no way back once the tabs were gone.
- **Browse apps** is the rail's binding (`useBrowseApps` in `workspace-rail.tsx`, which knows the
  apps): the + menu item runs that binding, so key, palette and menu do the same. Without apps the
  - menu item is absent and the binding's blocker says "You have no apps to browse here."
- **+ menu wording:** Apps gets the line "Add an app card to this conversation"; Browse apps "Open
  your app pickers in the side rail". Names stay the accessible names (`aria-labelledby`), the line
  is the description (`aria-describedby`).

## Acceptance criteria

- **ac-1 No Files or Apps button; their views remain reachable:** done. The tablist and its
  styles are removed; the section shows Files or Apps (`rail.tab`, still saved per member).
  - **Files:** Mod+Shift+F, `/files`, palette "Files", the top line's Files toggle, the collapsed
    strip's Show files, the bell's Repo notice, and the Apps view's Show files.
  - **Apps:** + menu › Browse apps, Mod+Shift+X, palette "Browse apps", and the collapsed strip's
    Show apps when Apps was the last view (unchanged, still meaningful: the strip opens the last
    view).
- **ac-2 No icon next to "Workspace:":** done (Vault icon removed from `WorkspaceHeader`).
- **ac-3 Gear "Manage projects" on the Projects line:** done. Registry command `manage-projects`
  (lucide `SettingsIcon`, no registry href, so not in the palette), an `IconAction` link to
  `/me/projects` right of "Projects", tooltip and accessible name "Manage projects"; shown to
  everyone who sees the Files panel, as the link was (it had no permission check).
- **ac-4 Tests, specs, guide:** unit: `workspace-tree.test.tsx`, `plus-menu.test.tsx` (Browse
  apps), `rail-views.test.tsx` (replaces `rail-tabs.test.tsx`), `rail-pickers.test.tsx`,
  `app-cards.test.tsx`, `rail-header.test.tsx`, `icon-action.test.tsx`; helpers `browseApps` and
  `showFilesFromApps` in `components/chat/testing.tsx`. Browser: `support/chat.ts` (same helpers,
  `pickTab`), `rail-header`, `gate-apps/picker`, `gate5/u17-workspace`, `frame-drag`,
  `rail-picker-scroll`, `projects-in-conversations`, `support/plus-apps.ts` (exact "Apps", since
  "Browse apps" also matches).

## Docs evaluation

Updated: `getting-started/layout.md` (no tabs; Files, the Manage projects gear, Browse apps and
the way back), `chat/composer.md` (+ menu: Apps vs Browse apps), `connectors-and-apps.md` (the
rail's Apps view and how to open it), `reference/keyboard-shortcuts.md` (Mod+Shift+X),
`files/workspaces-and-projects.md` (the gear). No "For agents" page covers the rail.

## Review (review-g146, merge)

Mod+Shift+X is free in Kaiju's shortcut registry and in Chrome, Edge and Safari; Firefox on Windows uses Ctrl+Shift+X to switch text direction in text fields, so in a text field there Firefox may act first; the + menu's Browse apps and the palette entry work everywhere.
