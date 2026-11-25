# KOBE-844: Workspaces rail tidy-up

- **Status:** partly done (items 2 and 3); item 1 held for Chris
- **Branch / worktree:** `group-146-workspaces-rail` in `../Kobe-g146`
- **Migrations / endpoints:** none.

## Acceptance criteria

- **ac-1 No Files or Apps button; their views remain reachable: NOT DONE, held.** The rail's
  Files | Apps buttons are the section's tablist (`components/shell/rail-tabs.tsx`, shown only when
  the member has apps). Entry points found:
  - **Files:** Mod+Shift+F, `/files`, the command palette ("Files"), the Files toggle in the rail's
    top line (folder icon, "Files panel"/"Files and apps"), the collapsed strip's Show files, and the
    bell's Repo conversion notice (`onShowFilesRequest`). Removing the Files tab would leave Files
    reachable.
  - **Apps** (the rail's Pickers section, `rail-apps.tsx`/`rail-pickers.tsx`): only the Apps tab
    (`rail.setTab("apps")`). The collapsed strip's Show apps appears only once the stored tab is
    already Apps; no shortcut, palette entry or `/` word reveals it; the composer's + menu → Apps
    launches app cards into the conversation, not the rail picker. Removing the tabs would make the
    rail picker unreachable, so per the brief nothing was removed. Needs a decision: e.g. a Show
    apps command (palette/shortcut) or a different home for the picker before the tabs go.
- **ac-2 No icon next to "Workspace:":** done; the Vault icon is gone from `WorkspaceHeader`.
- **ac-3 Gear icon "Manage projects" on the Projects line:** done. New registry command
  `manage-projects` (lucide `SettingsIcon`, scope rail, no registry href so it stays out of the
  palette); `ProjectsHeader` renders it as an `IconAction` link to `/me/projects` right of the
  "Projects" text, with tooltip and accessible name "Manage projects". Shown to exactly whom the
  link showed (everyone who sees the Files panel; there was no permission check). The collapsed rail
  hides the whole section as before; narrow rails truncate "Projects", the icon never shrinks.
- **ac-4 Tests, specs, guide:** `workspace-tree.test.tsx` (gear link, no text, on the heading's
  line, no Vault icon), `e2e/browser/tests/projects-in-conversations.spec.ts` (link name).

## Docs evaluation

`docs/guide/files/workspaces-and-projects.md` said "**Manage projects →** in the Files panel"; now
"the gear icon (**Manage projects**) beside the **Projects** heading". No guide page mentions the
Workspace icon. The Files/Apps tabs are unchanged, so their guide text stays.
