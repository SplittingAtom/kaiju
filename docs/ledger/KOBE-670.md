# KOBE-670: Show "Set by the Site" on Site memories for members (Gate C decision 9)

- **Status:** in review (committed locally on `kobe-670-sm`; coordinator pushes)
- **Branch / worktree:** `kobe-670-sm` in `../Kobe-wt670`
- **Depends on:** KOBE-399 (Open in Memory), KOBE-382 (Memories in context), KOBE-385 (curator lists), KOBE-403 (provenance rules)

## What changed (web only, no server or protocol change)

- `apps/web/lib/memory/items-api.ts`: `SET_BY_SITE = "Set by the Site"`, the one label string.
- `apps/web/components/memory/item-row.tsx`: a neutral console `Badge` "Set by the Site" in the
  row's meta line when `item.scope === "site" && readOnly`. This one rule covers:
  - My memory › Memories › **Opened from a conversation** (`/me/memory?item=<id>&scope=site`, the
    Open in Memory chip's target; Site items are always read-only there);
  - the team console **Memory › Memories** list with Scope = Site memories (always
    `curate: false`, for curators and plain members alike).
  - The site console's Memory list (`curate: true`) never shows it.
- `apps/web/components/shell/context-viewer.tsx` (+ css): "Set by the Site · " before each
  statement in the **Policy** and **Site memories** lanes of **Memories in context**, styled like the
  existing "Pinned · " prefix (muted foreground token, both themes).
- My memory's own lists only hold `user`/`portable` scopes, so no Site memory appears there except
  through Opened from a conversation.

## Decisions

- **Rule = "outside the site console", not "viewer is not a Site curator".** The web has no cheap
  Site-curator flag in member views, and the label reveals nothing a curator doesn't know, so a
  Site curator who opens a Site memory from a conversation or browses the team console sees the
  same label. Their provenance (source Workspace) stays where it already is: site console
  › Memory › Proposals. The site console's own Memories list gets no label (everything there is a
  Site memory). This keeps the label a pure function of where you are, so it can never leak.
- **Policy counts as set by the Site** in Memories in context (Policy items are Site items). The
  team console's read-only **Site Policy** section is already titled "Site Policy"; no label added.
- The API already distinguishes Site items by `scope` (item rows) and `lane` (run memories); no
  server change. `MemoryItem` carries no provenance field, and the row renders none; the item
  detail's `versions[].actor_kind` is never shown (test asserts "proposal"/"Workspace" absent).
- Text badge, not an icon; existing `Badge` (neutral tone, console tokens) and the context
  viewer's existing muted prefix style.

## Docs

- `docs/guide/memory.md`: Forget a memory (label on read-only Site memories), See which memories a
  run got (Policy/Site say Set by the Site), new section **Site memories outside the Site console**
  (where the label appears, source workspace only for Site curators under Proposals); summary.
- `docs/guide/glossary.md`: **Set by the Site** entry.
- For-agents pages: no change (the agent's block already says "set by the Site"; nothing new the
  agent sees).

## Evidence

- `components/me/my-memories.test.tsx` › "labels a Site memory 'Set by the Site' and names no
  Workspace (KOBE-670)"; the Workspace-memory case asserts no label.
- `components/admin/memory-consoles.test.tsx`: team console Site rows each labelled; site console
  (admin and steward) no label.
- `components/shell/context-viewer.test.tsx`: Policy and Site lanes labelled, Workspace lane not.
- Tests written first and seen failing (3 red), then green; `pnpm verify` before commit.
