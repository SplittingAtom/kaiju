# KOBE-847: Threads panel: no hover card or tooltip on conversation rows

- **Status:** in review (committed on the branch; coordinator pushes and opens the PR)
- **Branch / worktree:** `group-149-threads-no-hover` in `../Kobe-g149`

## Change

- Removed the hover card (`components/shell/rail-thread-card.tsx`, KOBE-219) from `ThreadItem`
  (it opened on pointer hover and on keyboard focus). Removed the row trigger's native `title`
  ("Forked from ...") and, as dead afterwards, `forkHint` (`lib/chat/fork.ts`, the adapter's
  `custom.forkHint`, their tests).
- Dead code removed: the card's styles (`.card*` in `rail.module.css`), `ThreadCard` type,
  `api.threadCard`, the fake `/card` route, the `lastActivity` helper.
- Rows keep the accessible name (the title) and keyboard behaviour: the trigger is the same
  `ThreadListItemPrimitive.Trigger`, still `aria-describedby` the activity dot.
- Tests: unit hover-card test removed from `threads.test.tsx`; `fork.test.ts` and
  `thread-list-adapter.test.ts` updated; browser spec `auto-title.spec.ts` now asserts that no card
  or tooltip opens when hovering the row.

## Kept on purpose

- The icon-only action buttons at the end of a row (pin, trash, restore, ⋯, line pin) keep their
  tooltips: they name icon-only controls, not the conversation row.
- The server route `GET /v1/threads/{id}/card`, its protocol schema and OpenAPI entry are now
  unused by the web app; left in place (API surface, out of scope). Candidate follow-up.

## Information only the card showed

First-message excerpt, agent name, last-activity time and message count are no longer visible on
the row. Last activity still orders the list; the agent and message count remain in the Context
panel and conversation header where shown; the first-message excerpt has no other place (the title
is usually derived from it). The fork provenance remains visible as the dashed fork leaf in the
tree. No test or guide relied on any of these.

## Docs evaluation

Checked `docs/guide` (threads-panel.md, sharing-and-branches.md, files pages) for the hover card,
row tooltips and "Forked from" hover: none described them. No guide change needed.
