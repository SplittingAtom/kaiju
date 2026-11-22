# KOBE-810: Rate limits held in memory are per replica: make the ones that matter count once across replicas

- **Status:** in review
- **Branch / worktree:** `group-94-rl-per-replica` in `../Kobe-g94`
- **Depends on:** KOBE-809 (merged: `kobe_rate_limits`)

## Plan

Owner-approved split (2026-11-22): move three in-memory limits to the Postgres limiter, keep every
other one per pod and document it as per replica by design, replace the gateway's bucket-map clear
with idle-bucket pruning.

## Decisions

- **The limiter moved to `@kobe/db`** (`packages/db/src/rate-limit.ts`): `takeRateLimit` (the same
  single atomic upsert, now `RETURNING count, window_start`, so callers get the time left for a
  `Retry-After`), `hitRateLimit` (boolean wrapper), `returnRateLimitHit` (takes back one hit of a
  named window), `pruneExpiredRateLimits` (prune errors go to a callback). There was no
  `checkRateLimit` on main; `takeRateLimit` is the minimal equivalent. The server keeps its
  `services/server/src/rate-limit.ts` API (`hitRateLimit(db, key, rule, now?)`, prune errors logged)
  as thin wrappers, plus `sharedRateLimit(db, name, rule)` (`allow(key)`, `reset()` for tests).
  No server code is imported into the gateway.
- **Gateway database access:** the model gateway already connects as the shared app role
  (`KOBE_DATABASE_URL`, chart helper `kobe.databaseEnv`, the same role as the server), which has all
  privileges on `kobe_rate_limits` (`packages/db/src/tenancy/identity.ts`). **No grant, no
  migration.**
- **Member per-minute model rate** (`services/model-gateway/src/member-rate.ts`): `DbMemberRate`, a
  fixed 60 s window per member, key `kobe:model-rpm:<team>:<user>` (same team+user key as the old
  bucket), max = the member's effective `requests_per_minute` (Site value or the Workspace's lower
  one). One upsert per model request in `BudgetGate.admit` (called once per request in
  `gateway.ts`, never per stream chunk; retries after Bifrost forgot a key do not re-admit). Same
  429 `rate_limited` "Too many model requests for this user; slow down." with `Retry-After` =
  seconds until the member's minute ends. Token bucket → fixed window: the same window shape as
  Bifrost's per-key limit, which stays as the backstop. A call refused right after by a budget
  gives its hit back (`returnRateLimitHit`, fire and forget), as the bucket did. `MemoryMemberRate`
  keeps the old bucket for unit tests and gates built without a database.
- **Fail closed:** Postgres unreachable for the count → 503 `rate_limit_unavailable` "The
  request-rate check is unavailable; retry shortly.", `Retry-After: 2`. The sandbox agent retries
  503s for up to 60 s; if Postgres stays down the run fails with `model_unavailable` and the member
  sees "The model gateway is unavailable right now. Try again in a moment." in the conversation.
  (With Postgres down the gateway's principal and reservation reads fail the same way.)
- **MCP App tool calls and card opens** (server): same per-user keys, now `kobe:app-call:<user>`
  and `kobe:app-launch:<user>` in Postgres, exact across server replicas; same 429 bodies.
  Bucket → fixed window with the same burst and sustained rate: calls 30 per 6 s (was burst 30,
  5/s), card opens 5 per 10 s (was burst 5, 1 per 2 s). Postgres unreachable: the request fails
  (the call itself needs the database anyway).
- **`RequestRate` pruning** (`services/model-gateway/src/limits.ts`): past `maxSandboxes`
  (10,000) a new sandbox first drops full (idle) buckets, then the least recently used, like the
  server's `createRateLimiter`. No global reset.
- **Inventory correction:** the split listed "External scanner calls" as a per-replica memory
  limit; the code (`skills/registry/external-scan.ts:168`) counts running scans in Postgres under
  an advisory lock, so it is Site-wide. Documented as Postgres. So 47 limits stay in memory by
  design, plus the gateway's `jti` replay set (documented per replica, owner's Q5 default).
- Comment drift fixed: `apps/call-deps.ts` no longer says launches share the app-call limit.

## Docs

- `docs/rate-limits.md`: limiter location, State column now storage + scope for every row
  ("Postgres … exact across replicas", "Memory (pod), per replica", "Memory (sandbox), per
  connection"), one "Per replica by design" paragraph, the three moved rows, the 10 missing
  limiters added (trace frames, relay budget, conflict frames, denied-call audit rows, rate-limited
  app audit row, validation pool, OAuth refreshes, approval-refusal audit throttle, OIDC discovery
  back-off, `jti` replay set), scan-pool line ref, gaps 1, 2 and the comment-drift item removed,
  what the sandbox sees on `rate_limit_unavailable`.
- `docs/guide`: no change. No guide page mentions the per-minute model rate or the MCP App rates;
  the limits now hold as configured, and the failure text a member sees already exists.
- No route or audit event added: `openapi.json` and the audit-events doc untouched.

## Evidence

- ac-1: `docs/rate-limits.md` (every in-memory row marked per replica / per connection, moved
  rows marked exact).
- ac-2: `services/model-gateway/src/member-rate.db.test.ts` "two replicas sharing the database
  admit the per-minute value once": two gates, two pools, 18 concurrent calls, rpm 6 → 6 admitted.
  With the in-memory store (pre-change behaviour) the same test admits 12 and the fail-closed test
  fails. Fail closed: same file (pool on a dead port → 503) and `budget-gate.test.ts`.
- ac-3: `services/model-gateway/src/limits.test.ts` (idle buckets dropped, a spent active bucket
  kept; LRU when none idle).
- ac-4: one upsert per model request, measured in `member-rate.db.test.ts` (200 sequential admits
  on a warm pool, dev Postgres over the LAN): **p50 2.27 ms, p95 2.81 ms** added per request,
  against model calls of seconds; the first call of each member minute also runs the bounded prune
  (≤ 100 rows). Not measurable against model latency; option (b) (fold into `kobe_reserve_budget`)
  not needed.
- Server: `services/server/src/apps/app-rate-limits.db.test.ts` (both limits across two limiter
  instances on two pools; reset; DB unreachable; `takeRateLimit` window and give-back);
  `team-apps`, `app-cards`, `app-launch-agent`, `rate-limit` DB tests and
  `kobe-mcp/session-contract.test.ts` green.
- Gateway: unit suite (260) and DB suite (28) green; `@kobe/db` unit suite green; typecheck of
  db, server, model-gateway clean.
