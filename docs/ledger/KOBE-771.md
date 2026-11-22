# KOBE-771: OpenAPI request and response bodies for the catalog operations; SCIM and auth routes allowlisted one by one

- **Status:** in progress (commits on `group-81-openapi-bodies`, not pushed)
- **Branch / worktree:** `group-81-openapi-bodies` in `../Kobe-g81`
- **Depends on:** KOBE-727 (catalog and coverage guard)

## Plan

Give every catalog operation a request and response schema, built from the routes' own zod
schemas and the `@kobe/protocol` contracts, area by area; replace the `/api/auth/*` and
`/v1/scim/v2/*` wildcards on the allowlist with individual routes.

## Decisions

- **Builder** (`openapi/catalog/build.ts`): an area marked `detailed: true` has a `CatalogDetail`
  per entry in `openapi/catalog/details/<area>.ts`: `body` (a zod schema, or `null` when the route
  reads none), `query` (the route's zod object, or hand-read parameters), `multipart` / `rawBody`
  for uploads, `status` + `response` (+ `otherSuccess` for a second success status), `produces`
  for downloads/SSE/HTML, extra `errors`, `teamScoped` (adds the X-Kobe-Team header). Building
  throws on a missing detail in a detailed area, a body on GET, a non-204 answer without a schema,
  a detail for no entry, and one component name used for two schemas (also against the
  hand-written areas, `mergeSchemas`).
- **Schema sources:** `named("Name", zodSchema)` turns the route's or protocol's zod schema into a
  component (request bodies as zod input, answers as output). Route files changed only by adding
  `export` to existing schema consts (30 files; diff checked to be export-only). Wrappers such as
  `z.object({ items: z.array(protocolItemSchema) })` are written in `details/` where a handler sends
  a protocol item in an envelope.
- **Untyped responses:** where a handler builds its JSON without any schema, the component lists
  the fields the handler sends (traced through its helpers, enum values taken from code constants)
  and carries `x-kobe-untyped: true`. Count of operations whose success body is untyped, per tag
  (operations/untyped): Threads 23/7, Runs 2/0, Artifacts 5/0, Workspace 2/0, Schedules 7/0,
  Me 18/13, Files 3/0, Connector grants 4/3, Setup 2/1, Projects 15/0, Agents 21/19,
  Site: gallery 15/14, Memory 39/33, Site: memory 10/10, Skills 56/43, Team 55/39,
  Team: skills 23/18, Site: people 48/40, Site: compliance 44/43, Site: platform 41/33,
  Site: skills 48/38. Follow-up candidate: move these shapes into zod schemas next to the routes
  (or protocol) so the routes and the document share one definition. Free-form stored documents
  (eval reports, scan/scorecard/manifest payloads, audit `target`, app call `result`, break-glass
  entry `payload`, frontmatter) are typed as open objects.
- **Errors:** shared `components.responses` (BadRequest, Unauthenticated, Forbidden, PaymentRequired,
  NotFound, MethodNotAllowed, Conflict, LengthRequired, PreconditionFailed, PayloadTooLarge,
  UnsupportedMediaType, Unprocessable, PreconditionRequired, RateLimited, BadGateway, Unavailable,
  InsufficientStorage), all with the `Error` envelope; 400/401/403 by default (Setup: none, it has
  no session), the rest per operation. The fully hand-written areas are unchanged.
- **Allowlist:** `GET`/`POST /api/auth/{path}` (Better Auth's single catch-all) and the 11 SCIM
  routes are listed one by one; a new test fails on any prefix wildcard outside the sandbox and
  internal listeners. `POST /v1/site/gallery/agents/{id}/unarchive` moved from the catalog to the
  allowlist: it always answers 405 `gallery_read_only` (registered so the version routes cannot
  take the path), so it has no success answer to document. Catalog operations: 481 (was 482).
- **Validation:** no OpenAPI validator is a dependency, and none was added; `catalog/detail.test.ts`
  checks detailed areas (2xx schema, request body when read, errors only via shared responses),
  that every `$ref` resolves, path parameters match the template, no duplicate parameters.
- Built by area agents in parallel (one catalog file each), integrated and checked here.

## Found while reading handlers (no behaviour changed)

- `GET /v1/runs/{id}/usage`: for a run without usage the fallback answer omits `user_entry_id`,
  which `runUsageSchema` (strict) requires.
- `GET /v1/team/skills/installs` sends `pinnedBy` and `retirement`, which the strict
  `teamSkillInstallSchema` does not allow (the document extends it).
- Skill eval answers drop the cost fields (`costsHidden: true`) for other viewers although
  `skillEvalRunSchema` requires them.
- `/v1/memory/vectors` sends its job object in camelCase, unlike the other memory answers.
- Team app routes (`/calls`, `/tools`) answer errors as `{error: {code, message}}`, not `Error`.
- Setup's 400 answers `{code, issues}`. Some query parameters missing answer 404 rather than 400
  (Site connector template `source`/`frame` `uri`, registry `file` `path`).
- The move-version body in `routes/team-skill-installs.ts` is an inline schema in the handler; it
  is restated in `details/team-skills.ts` (cannot be exported without touching the handler).

## User-facing docs

No `docs/guide/` change: the guide has no API reference and the OpenAPI document is not served
in the app; nothing a member, admin or agent sees changes. `docs/development.md` ("OpenAPI
document") describes how to document a route with a detail.

## Evidence (acceptance criteria → test or command output)

- ac-1: every catalog operation detailed: `openapi.json` has 0 operations with
  `x-kobe-detail: summary`; `catalog/detail.test.ts` (all 21 tags in `DETAILED_TAGS`).
- ac-2: `undocumented-allowlist.ts`; `coverage.test.ts` "names user-facing routes one by one".
- ac-3: `vitest run src/openapi src/route-inventory` green; server typecheck, eslint and
  prettier clean; server unit suite 302 files, 4024 tests passed.
