# KOBE-849: Workspaces rail: Files and Apps tabs back

- **Status:** done, in review
- **Branch / worktree:** `group-151-rail-tabs-back` in `../Kobe-g151`
- **Migrations / endpoints:** none (the stored tab stays `rail_tab`).

## What changed

Chris (2026-11-27) reversed item 1 of KOBE-844: the rail's one section has its **Files | Apps**
tabs again. `rail-tabs.tsx` and `rail-tabs.test.tsx` are restored from before PR #742, and the
KOBE-844 changes to `workspace-rail.tsx`, `rail-apps.tsx` and `rail.module.css` are reverted:
ARIA tablist with automatic activation, Left/Right (wrapping), Home/End, one tab stop, both
panels kept mounted, the chosen tab saved per member (`rail_tab`), no tablist without apps or a
key to add. Apps is the Pickers section (the picker MCP UI apps placed in the rail); Files is the
workspace tree. The collapsed strip's single Show files / Show apps icon (opens on the last tab)
and the phone drawer are as before KOBE-844.

Kept from KOBE-844: no icon next to "Workspace:", the Manage projects gear beside Projects.

## Decisions (entry points added by KOBE-844)

- **Apps view's Show files icon: removed.** The Files tab is the way back; the icon duplicated it
  in the panel's own header (which also goes: the tab names the panel).
- **+ menu Browse apps: kept,** and it selects the Apps tab (`rail.reveal("apps")`, which sets and
  saves the tab), so there is one Apps view. It reaches the pickers from the composer without
  aiming at the rail, and still says how it differs from Apps (an app card).
- **Palette entry and Mod+Shift+X: kept.** Same binding (`useBrowseApps` in `workspace-rail.tsx`);
  the keyboard counterpart of Mod+Shift+F for Files. Without apps the blocker still says "You
  have no apps to browse here."

## Acceptance criteria

- **ac-1 Files and Apps tabs; Apps lists the picker apps:** done (`rail-tabs.test.tsx`).
- **ac-2 KOBE-844's icon removal and gear stay:** done (`workspace-tree.test.tsx` unchanged).
- **ac-3 Entry points decided; tests, specs, guide:** done. Unit: `rail-tabs.test.tsx` (restored,
  plus Browse apps selects the tab, no Show files, no-apps Mod+Shift+X), `rail-views.test.tsx`
  removed, `rail-pickers`, `app-cards`, `rail-header` back to the tabs, `plus-menu` (Browse apps
  selects the Apps tab), helper `showFilesFromApps` removed and `browseApps` returns the tabpanel.
  Browser: `support/chat.ts` (`pickTab` clicks tabs), `rail-header` (tabs, then no Show files and
  Mod+Shift+X selects Apps), `gate-apps/picker`, `gate5/u17-workspace`, `frame-drag`,
  `rail-picker-scroll` back to the tabpanel.

## Docs evaluation

Updated: `getting-started/layout.md` (two tabs again, the keys, Browse apps selects Apps, the
gear), `files/workspaces-and-projects.md` (the Files tab and the Apps tab beside it),
`chat/composer.md` (Browse apps selects the Apps tab), `connectors-and-apps.md` (the rail's Apps
tab and the ways to it), `reference/keyboard-shortcuts.md` (Mod+Shift+X selects the Apps tab).
No "For agents" page covers the rail.
