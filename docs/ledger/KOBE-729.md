# KOBE-729: Split the 300-500-line route builders into per-group Hono sub-routers

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator lands it)
- **Branch / worktree:** `group-67-route-subrouters` in `../Kobe-g67`
- **Depends on:** KOBE-703 (shared route helpers, already on main)

## Plan

Pure refactor of the HTTP surface (review CODE-14): each listed route builder becomes a short
parent that keeps its own middleware (`app.use`) and `onError`, makes one per-router "kit"
(shared state and closures that used to live in the builder), and mounts per-group sub-routers
with `app.route("/", group(kit))` in the original order. One commit per area.

| Area                                       | Before (file / builder) | After (largest file / builder) |
| ------------------------------------------ | ----------------------- | ------------------------------ |
| `routes/skill-drafts.ts` + `skill-drafts/` | 745 / 547               | 230 / 129                      |
| `workspace-sync/routes.ts` + `routes/`     | 635 / 467               | 191 / 114 (kit factory 163)    |
| `routes/threads.ts` + `threads/`           | 697 / 471               | 199 / 126                      |
| `routes/agents.ts` + `agents/`             | 481 / 364               | 119 / 89                       |
| `routes/projects.ts` + `projects/`         | 445 / 316               | 172 / 140                      |
| `routes/site-skill-catalog-edit.ts` + dir  | 397 / 313               | 131 / 113                      |
| `routes/site-connectors.ts` + dir          | 385 / 293               | 121 / 95                       |
| `routes/project-commits.ts` + dir          | 472 / 247               | 175 / 85                       |
| `routes/schedules.ts` + `schedules/`       | 372 / 275               | 120 / 89                       |
| `routes/memory.ts` + `memory/`             | 311 / 222               | 169 / 76                       |

## Decisions

- **Order is the contract.** Hono matches in registration order and `route()` copies a
  sub-app's routes in order, so every group is a contiguous slice of the original handler list
  and groups mount in that order (e.g. `/:id/egress-blocked` stays between the branch and label
  routes). Middleware stays on the parent, before the groups, so its patterns (`*`, `/:id`,
  `/:id/*`) are registered exactly as before; sub-routers carry no middleware and no `onError`
  (a sub-app `onError` would wrap its handlers; workspace sync keeps its `onError` on the parent).
- Handler bodies moved verbatim; only their imports changed. Exports other modules use stay at
  the old paths (`draftJson`, `readBounded`, `WORKSPACE_*`, `myCheckoutRoutes`,
  `teamStorageRoutes`, `mountAgentRosterRoutes` usage), so `app.ts` and the OpenAPI test are
  untouched.
- Agents: the roster, transfer, version, eval, Orbit, feedback and eval-case mounts stay on the
  parent at their original positions.
- Site connectors: `DELETE /:id` stays on the parent after the template group (its original
  place), rather than in a group whose subject it isn't.
- OpenAPI is a static document (`openapi/*.ts`), not attached to route objects, so the split
  cannot move it; `threads/repository.ts` is untouched (group 66 splits it).
- The workspace sync kit factory (163 lines) holds state, not routes; ac-1 is about route
  builders, so it stays one closure (splitting it would change nothing a reader gains).

## Open questions (for Chris or the coordinator)

- None.

## Docs (docs/guide)

No guide change: nothing a member, admin or in-sandbox agent sees or can do changed (same
paths, methods, bodies, status codes and auth); this only reorganises server source files.

## Evidence (acceptance criteria → test or command output)

- **Route inventory first:** commit `test: snapshot the ordered route and middleware table…`
  adds `services/server/src/route-inventory.test.ts` with file snapshots
  `src/__snapshots__/route-inventory.app.txt` (962 entries: every `METHOD path handler-name` of
  the real app, middleware `ALL` entries included, in matching order) and
  `route-inventory.workspace-sync.txt` (sandbox listener). Both snapshots are unchanged by every
  later commit (the test passes without `-u`).
- **Stricter local check (not committed):** after each area, a throwaway test dumped every route
  entry with a hash of its handler source (whitespace and Vite import-rewrite normalised) for
  both listeners, plus the full `openApiDocument()` JSON; all three were byte-identical to the
  pre-refactor baseline after every one of the ten areas.
- **ac-1:** no route builder in the listed files is over ~150 lines (largest: 140, `projects/files.ts`).
- **ac-2:** `openapi/document.test.ts`, `app.test.ts`, `route-inventory.test.ts` green; `pnpm
verify` green (2026-11-21); `pnpm --filter @kobe/server test:db`: 269 files, 3328 tests passed.
