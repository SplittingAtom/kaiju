# KOBE-727: OpenAPI completeness guard (review CODE-39)

- **Status:** in review (group 66 branch `group-66-repo-splits-openapi`)
- **Branch / worktree:** `group-66-repo-splits-openapi` in `../Kobe-g66`
- **Depends on:** none

## Plan

Owner decision 2026-11-20: a guard test (every mounted route documented or allowlisted with a
reason) and documentation for the member and admin API only; internal, sandbox-facing, SCIM,
webhook-like and proxy routes go on the allowlist.

## Decisions

- `services/server/src/openapi/coverage.test.ts` builds the real apps (`createApp` with the
  isolation gate, `createSandboxApp`, `createInternalApp`) with stand-in dependencies (a Proxy:
  routes are registered, no handler runs) and reads `app.routes`. It fails on: a user-facing
  route neither documented nor allowlisted; a documented operation no listener mounts; a
  sandbox/internal route not allowlisted; an allowlist entry matching no route (stale) or a
  documented route; missing/duplicate operationIds. A sanity check (>500 routes, known routes
  present) keeps a broken stand-in from passing vacuously. Negative check done by hand: removing
  a catalog line and adding a stale entry both fail.
- Documentation depth: the 482 missing operations are one line each in
  `openapi/catalog/*.ts` (summary, optional notes on permission/status/side effects, tag, path
  parameters, generic body and `{code, message}` error), marked `x-kobe-detail: "summary"`.
  Request/response schemas for them are left for follow-ups (below). The 126 fully described
  operations are unchanged; `mergePaths` refuses a catalog line that duplicates one.
- Summaries were drafted from each handler and its comments (permission names checked to exist
  in code); nothing in `routes/` changed (PR #654 touches those files).
- Allowlist (`openapi/undocumented-allowlist.ts`, 10 entries, reason each): probes (2), Better
  Auth `/api/auth/*` (1), SCIM `/v1/scim/v2/*` (1), OAuth client metadata + connector OAuth
  callback (2), web-vitals telemetry beacon (1), the gallery's catch-all write refusal (1),
  sandbox listener `/v1/sandbox/*` (1), internal listener `/internal/v1/*` (1).
- `document.test.ts`: the thread and run "describes exactly" checks now include the routers the
  catalog lists; the semantic-memory contract check allows catalog-only `/v1/memory` operations.
- Docs: `info.description` and `docs/development.md` ("OpenAPI document") state the coverage.
  No `docs/guide/` change: the guide has no API reference page and the OpenAPI document is not
  served in the app; nothing a member, admin or agent sees changes.

## Follow-ups (undocumented bodies, ac-3)

Summary-level operations per tag (request/response schemas still to describe): Skills 56,
Team 55, Site: people 48, Site: skills 48, Site: compliance 44, Site: platform 41, Memory 39,
Team: skills 23, Threads 23, Agents 21, Me 18, Site: gallery 16, Projects 15, Site: memory 10,
Schedules 7, Artifacts 5, Connector grants 4, Files 3, Runs 2, Workspace 2, Setup 2.
Suggested order: Me/Team/Projects/Agents (most used by clients), then Site areas.

## Evidence (acceptance criteria → test or command output)

- ac-1: `vitest run src/openapi` (coverage + document tests) green; negative checks fail as
  intended.
- ac-2: `openapi.json` `info.description`, `docs/development.md`.
- ac-3: follow-up list above.
- Counts: user-facing listener 630 operations = 126 fully described + 482 summary-level + 22
  allowlisted; sandbox listener 2 and internal listener 8 routes, all allowlisted.
