# KOBE-719: Web: stale TODOs and locally re-declared protocol shapes (review CODE-23)

- **Status:** in review (group 54, local commits)
- **Branch / worktree:** `group-54-web-chat` in `../Kobe-g54`
- **Depends on:** none

## Plan

- `lib/threads/file-links.ts`: check the three answers against the `@kobe/protocol` schemas
  (`threadFileLinksSchema`, `threadFileLinksResponseSchema`, `fileThreadsResponseSchema`) and take
  the limits from there (`THREAD_FILE_LINKS_MAX_THREADS`, `FILE_THREADS_MAX_PATHS`).
- `lib/files/api.ts`: `nextCursor` comment says what the server sends (`next_cursor`).
- Curator `stale` (TODO KOBE-386): decide from the server and the contract.
- `services/server/src/runs/run-mcp.ts`: the stale `TODO(KOBE-61)` reference dropped.

## Decisions

- **Wire casing back for the check.** The client camelizes every answer, and the protocol schemas
  are snake_case and strict, so the answer goes back to wire casing before the check and is handed
  out camelized again, as `lib/chat/folders-api.ts` already does. The web's exported types
  (`LinkedFile`, `ThreadFileLinks`, `FileThread`, `FileThreads`) keep their camelCase shape.
- **Strict is right here (not loosened).** The protocol schemas are stricter than the old local
  copies: uuids for `thread_id`/`project_id`, an ISO timestamp for `last_at`, a valid workspace
  path, `title` present (nullable, no longer optional), no unknown fields, and caps on the arrays.
  The server builds these bodies from the same contract types (`thread-file-links/read.ts`,
  openapi from the schemas), so it already sends exactly this; nothing had to be relaxed. The
  consequence to know: a field the server adds later makes the web refuse the answer
  (`malformed_response`) until the web ships with the new protocol (web and server deploy together).
- **`stale` is not a status.** `services/server/src/memory/suggestions/decide.ts` uses `stale` for
  project-note suggestions, not items; for items KOBE-386 made staleness a computed flag
  (`stale?: boolean` on every item response) and a `stale=true|false` list filter, while
  `status` stays active/archived/superseded (`SEMANTIC_MEMORY_STATUSES`). So the web type gains
  `MemoryItem.stale` and `ListQuery.stale` (sent as `stale=`), the curator's status filter keeps
  its three statuses and the TODO is replaced by that explanation. No filter is added to the UI
  (that would be a user-facing change; a follow-up if wanted).
- **Guide:** no user-facing change (validation, types and comments only): no docs/guide update.

## Open questions (for Chris or the coordinator)

- A "Stale" filter in the curator console now only needs `ListQuery.stale`; worth a ticket?

## Evidence (acceptance criteria → test or command output)

- ac-1: `lib/threads/file-links.ts` imports the protocol schemas and limits; the local zod
  shapes and the second `FILE_THREADS_MAX_PATHS` are gone. `file-links.test.ts`: answers are
  camelized after the check; unknown fields, non-uuid ids and bad timestamps are refused.
- ac-2: TODO(KOBE-611), TODO(KOBE-184), TODO KOBE-386 and the KOBE-61 stub reference resolved;
  `lib/memory/items-api.test.ts`: an item with `stale: true` passes `semanticMemoryItemSchema`, a
  `status: "stale"` does not, the flag reaches the web item, and `listPath({ stale })` produces a
  query `semanticMemoryListQuerySchema` accepts.
- ac-3: `lib/threads`, `lib/memory`, `components/memory`, the shell file-map tests: 17 files,
  133 tests green; full web suite and `pnpm verify` before the commit.
- Web tests: 426 files / 3817 tests before, 427 / 3821 after. `pnpm verify`: green except two
  `@kobe/skill-scanner` bypass tests timing out at 5 s under machine load (unrelated; the package
  reran green alone), then `turbo run test --concurrency=2`, license, hygiene and wording green.
