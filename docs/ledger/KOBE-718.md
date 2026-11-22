# KOBE-718: Web: break up oversized client components, starting with FileBrowser

- **Status:** in review (group 61, branch `group-61-web-splits-protocol`), partly done
- **Branch / worktree:** `group-61-web-splits-protocol` in `../Kobe-g61`
- **Depends on:** none

## Done (pure refactor, no behaviour change; function lengths by the TS AST, start to end)

| Component                                                            | Before | After | Moved to                                                                                                                                                     |
| -------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FileBrowser` (`components/files/file-browser.tsx`, 797 → 283 lines) | 450    | 191   | `use-wake.ts`, `use-tree-focus.ts`, `use-file-actions.ts`, `file-tree-actions.ts`, `file-row-menus.ts`, `file-browser-parts.tsx`, `file-browser-dialogs.tsx` |
| `ApprovalCard` (`components/chat/approval-card.tsx`)                 | 245    | 176   | `approval-card-parts.tsx`, `use-approval-card.ts`                                                                                                            |
| `CuratorMemories` (`components/memory/curator-memories.tsx`)         | 259    | 136   | `curator-filters.tsx`, `use-curated-list.ts`                                                                                                                 |
| `ItemRow` (`components/memory/item-row.tsx`)                         | 290    | 198   | `item-row-parts.tsx`, `item-row-ids.ts`                                                                                                                      |
| `ThreadsPanelContent` (`components/shell/threads-panel.tsx`)         | 279    | 197   | `threads-panel-parts.tsx`, `use-thread-file-map.ts`                                                                                                          |
| `ReviewSection` (`components/memory/review/review-section.tsx`)      | 249    | 189   | `review-section-parts.tsx`                                                                                                                                   |

Exports the old modules had stay where they were (re-exports for `pretty`, the item-row button
ids, `ListedScope`/`SharedScope`). Tests unchanged.

## Left for a follow-up

`Composer` (405), agent `Builder` (377), `useEditorState` (250) and `attachHostBridge` (236,
security-relevant bridge whose checks the ticket wants kept together): each is a large,
state-heavy split that did not fit this group cleanly; ac-1 is not met for them yet.

## Decisions

- One commit for the ticket (coordinator's rule for this group) instead of one per component.
- User-facing docs: none needed (no visible change).

## Evidence

- `pnpm --filter @kobe/web exec vitest run components/files components/chat components/memory
components/shell components/admin` green; web `typecheck` and `lint` (jsx-a11y) clean.
