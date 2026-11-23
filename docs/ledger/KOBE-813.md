# KOBE-813: Add rate limits where none exist

- **Status:** in review (group 91 branch `group-91-rl-missing-limits`, on `group-85-rate-limit-store`)
- **Branch / worktree:** `group-91-rl-missing-limits` in `../Kobe-g91`
- **Depends on:** KOBE-809 (durable limiter, `kobe_rate_limits`)

## Plan

Ten fixed limits on the durable Kobe limiter, one 429 shape with `Retry-After`, OpenAPI 429 on
each documented operation, a plain message wherever a member or admin meets one in the web app.

## Decisions

- **Values (owner, 2026-11-22), fixed in code, not configurable:** `OPERATION_LIMITS` in
  `services/server/src/operation-limits.ts` holds all ten (bucket, window, max, sentence).
- **Per member across Workspaces.** Keys are `<bucket>:<user id>` like every other per-member
  Kobe limit (`skill-upload:`, `thread-fork:`…); no existing limit is per member per Workspace.
  SCIM tokens per Site admin; setup per client IP.
- **Retry hint.** New `checkRateLimit` returns `{allowed, retryAfterSeconds}` (window end from the
  row's `window_start`); `hitRateLimit` keeps its boolean API. `rateLimited()` sends
  `{code: "rate_limited", message}` + `Retry-After`.
- **Runs.** Counted at the member's HTTP entry points only: `POST /v1/threads/{id}/messages`
  (composer, regenerate/edit, app "send message", Workbench test chat) and
  `POST /v1/runs/{id}/retry`, one shared `run-submit` bucket. Schedules firing
  (`SchedulerRunner` → orchestrator directly) and skill evals never pass there, so they neither
  count nor are refused (test). The Kobe admin MCP and apps start no runs server-side.
- **Compaction and branch summary** get separate buckets (10 per 10 min each), not one shared
  bucket (shared buckets are listed as a smell in the inventory). Pi's automatic compaction is
  not a route and never counts.
- **Uploads.** `POST /v1/uploads` (composer; apps use the same transport) and, after review M1,
  `POST /v1/workspace/files` (Files panel, conversation rail drop) share the `upload` bucket.
  Both take one file per request (multi-file drops send one request per file), so one hit per
  file. Editor saves (`PUT /v1/workspace/file`) are writes, not uploads: not counted.
- **One start counts once (review H1).** `admitWakeStart`: the first ask for an asleep sandbox
  sets a marker `sandbox-wake-start:<workspace>:<member>` (5 min window, longer than the
  viewer's 3 min of polling) and counts one wake; asks while it is set are free; the marker is
  cleared when the sandbox is seen connected (`/wake`, the context viewer) and at once when the
  start is refused (so a refused start is not passed as "in progress"). Per Workspace marker,
  per member bucket.
- **Notebook cell runs (review M2).** Own bucket, 300 per minute per member (owner decision
  2026-11-22; first proposed at 120), apart from the 60/min message limit. Run all sends one request per cell,
  serially, so the unit is a cell; counted inside the run's transaction (`prune: false`), so the
  `thread_busy` answers Run all retries and refusals add nothing. Their implicit wake is a run's
  wake: not counted. The kernel bar shows the server's sentence.
- **Wake start is atomic (round 2, M-R2-1).** Marker upsert and bucket hit run in one
  transaction (`prune: false`); a refusal rolls both back. A concurrent ask waits on the
  marker's row lock, then finds no marker and is checked itself, so a member at the limit can't
  get a free wake with parallel requests (test: 8 concurrent asks at the limit, none allowed;
  8 under it, exactly one hit).
- **File-write routes (round 2, L-R2-1).** In the `upload` bucket: `POST /v1/uploads`,
  `POST /v1/workspace/files`, `POST /v1/projects/{id}/files` (after the edit check). Deliberately
  not: `PUT /v1/workspace/file` (editor save, a write of a file already there),
  `PUT /v1/site/branding/assets/{kind}` (Site admin, logo assets overwritten in place), skill
  uploads and imports (their own `skill-upload` bucket), budget and team skill install routes
  that read a small text body (settings, not stored files), `POST .../notebook/restart` (kernel, not the sandbox; unlimited, noted).
- **Lows.** L1/L2/L5 noted in docs/rate-limits.md (L2 recovery also in docs/install.md); L3 fixed
  (Files panel shows the server's 429 sentence); L4 counts corrected; L6 below.
- **Sandbox wakes.** Counted only for wakes the member asks for: `POST /v1/workspace/wake` (Files
  panel), Refresh (`POST /v1/workspace/sync`) of an asleep sandbox, and the context viewer's wake.
  An already-connected sandbox is not counted (the panel calls wake on every mount). A run's own
  wake is never counted or refused, so a message never fails for it; runs are bounded by the run
  limit. Notebook kernel starts keep their own limit. Over the limit: 429, the Files panel says
  the sandbox stays asleep and shows the last synced files; the context viewer answers its
  contract's `rate_limited`.
- **Feedback.** Rating (`PUT`) and clearing (`DELETE`) both count.
- **SCIM tokens.** Create and rotate share one bucket per admin; counted before the 2-live check.
- **Setup.** Every `POST /v1/setup` attempt before an Owner exists counts per client IP (resolved
  as audit does, through the trusted proxies). No resolvable IP → one shared `unknown` bucket
  (fail closed). Once over, even the right token is refused. The token comparison was already
  constant-time (`timingSafeEqual` of SHA-256 digests, `deps.ts` `isSetupToken`).
- **Web.** Most surfaces already show the server's 4xx message (send, Retry, compact, branch
  summary, schedules, SCIM tokens). Changed: composer uploads (429 was "upload failed (HTTP
  429)"), answer ratings (generic "wasn't saved"), setup page (generic), Files panel wake notice.
- **Docs.** docs/rate-limits.md rows per area, gap 5 replaced; guide: Troubleshooting table
  ("Too many …"), SSO page (SCIM token limit). No For agents change: an in-sandbox agent cannot
  call any of these routes (no member session; the Kobe admin MCP has its own limits and no
  tool for these operations).

## Open questions (for Chris or the coordinator)

- `POST /v1/workspace/wake` and `/sync` are not in the OpenAPI document (whole `/v1/workspace/*`
  files area is undocumented there; review L6: the coverage test builds the app without
  `workspaceFiles`, so it never sees them). Follow-up ticket suggested; their 429 is documented
  in docs/rate-limits.md only.

## Evidence (acceptance criteria → test or command output)

- Review fixes: `operation-limits.db.test.ts` "one start counts once" (viewer's real schedule
  over 3 min, plus panel and Refresh: one hit), `thread-context.db.test.ts` (6 polls, one hit),
  `notebooks.db.test.ts` (limit, busy not counted), `workspace-files.db.test.ts` (shared upload
  bucket); each failed before its fix.
- ac-1: `operation-limits.db.test.ts` (each limit: max allowed, next refused with the window's
  `retryAfterSeconds`, allowed after the window via `now`; route 429s; scheduled run fires at the
  member's limit and is not counted), `setup-limit.db.test.ts`, and a case each in
  `uploads.db.test.ts`, `workspace-files.db.test.ts`, `workspace-events.db.test.ts`,
  `scim.db.test.ts`.
- ac-2: `expectRateLimited` checks body and `Retry-After` everywhere; web tests in
  `uploads.test.ts`, `answer-feedback.test.tsx`, `auth-pages.test.tsx`, `workspace-tree.test.tsx`.
- ac-3: docs/rate-limits.md, docs/guide/reference/troubleshooting.md,
  docs/guide/admin/single-sign-on.md.
- ac-4: openapi catalog + hand-written areas; `UPDATE_OPENAPI=1 … src/openapi` regenerated.
- ac-5: `setup-limit.db.test.ts`.
