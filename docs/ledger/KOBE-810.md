# KOBE-810: Rate limits held in memory are per replica: make the ones that matter count once across replicas

- **Status:** in review
- **Branch / worktree:** `group-94-rl-per-replica` in `../Kobe-g94`
- **Depends on:** KOBE-809 (merged: `kobe_rate_limits`)

## Plan

Owner-approved split (2026-11-22): move three in-memory limits to the Postgres limiter, keep every
other one per pod and document it as per replica by design, replace the gateway's bucket-map clear
with idle-bucket pruning.

## Decisions

- **The limiter lives in `@kobe/db`** (`packages/db/src/rate-limit.ts`), the only place with its
  SQL. Every function takes the pool or a transaction (`RateLimitDb = Pick<KobeDb, "execute">`)
  and `RateLimitOptions { now?, prune?, onPruneError? }`:
  - fixed window: `takeRateLimit` (the KOBE-809 upsert unchanged, now `RETURNING count,
window_start` for the time left) and `hitRateLimit` (boolean); existing callers unchanged;
  - refilling bucket (review M1, coordinator's decision): `takeRateBucket` (GCRA, one atomic
    upsert), `returnRateBucketToken`, `bucketIntervalMs`;
  - `clearRateLimit(db, key)`, `pruneExpiredRateLimits(db, now?, batch?, onError?)`.
    The server's `services/server/src/rate-limit.ts` keeps `hitRateLimit(db, key, rule, now?)`,
    `pruneExpiredRateLimits` (prune errors logged), re-exports `clearRateLimit`, `RateLimitDb`,
    `RateBucketRule`, and adds `sharedRateLimit(db, name, bucketRule, now?)` (`allow`, `reset(key)`).
    No server code is imported into the gateway.
- **GCRA in the existing columns, no migration:** `window_start` holds the theoretical arrival
  time (TAT, epoch **µs**; when the bucket is full again), `expires_at` the same instant in ms
  (rounded up, for the shared prune), `count` is 1 when the last request was admitted and 0 when
  refused (how the single statement reports its verdict; Postgres 17 has no `OLD` in
  `RETURNING`). With T = ceil(1e6 / perSecond) µs: admit when
  `max(TAT, now) + T - now <= burst * T`, then TAT = `max(TAT, now) + T`; a refusal leaves TAT
  alone (refused requests are not charged, which also fixes review L2's give-back) and its wait is
  `TAT + T - burst * T - now`. A row whose TAT has passed is a full bucket, so the general prune
  (`expires_at < now`) removes it without changing behaviour. Keys never share a prefix with
  fixed-window ones. T rounds up to a whole µs (never more permissive; at most 0.02 % stricter at
  rpm 10,000, exact for the defaults: rpm 60 → 1 s, app calls 200 ms, card opens 2 s; review
  R2-L1). The statement is `WITH n AS (SELECT now) , up AS (INSERT … SELECT … FROM n ON CONFLICT
DO UPDATE …) SELECT … FROM up, n`: the insert's own values carry "now" into the conflict branch
  (`EXCLUDED.window_start` = now + T), still one round trip.
- **Database clock (review R2-M1):** unless a caller injects `now` (tests), the bucket, the fixed
  window and the prune read `clock_timestamp()` inside their statement. Before, each pod's clock
  counted: under GCRA a pod running s ahead shrank the others' burst by s/T, past ~60 s locked a
  member out on the other pods with a Retry-After of about s, and its prune deleted rows still
  owing tokens. The fixed window had the same exposure in a milder form (a pod ahead restarted
  windows early, a pod behind extended them, Retry-After off by the skew, early prunes), and the
  change there was small and safe for every caller (none of the 45 server call sites passes a
  time; the server wrapper's `now` became optional), so it is applied there too. Not changed: the
  password-reset resend claims (`auth/reset-links.ts`, its own SQL, a 5-minute guard written with
  the pod's time; a skew only shifts when a second email is allowed). Noted follow-up if wanted.
- **Gateway database access:** the gateway already connects as the shared app role (chart helper
  `kobe.databaseEnv`), which has all privileges on `kobe_rate_limits`
  (`packages/db/src/tenancy/identity.ts`). **No grant.** The rate check runs on its own pool
  (`MEMBER_RATE_DB`: 2 s acquire, 2 s `statement_timeout`, application name `kobe-gateway-rate`;
  size `KOBE_MODEL_GATEWAY_RATE_POOL_MAX`, Helm `modelGateway.database.ratePoolMax`, default 2,
  1–50, review R2-L3), so a slow or saturated database fails fast. The main pool's 10 s acquire
  timeout (`createDb` default, all services) is deliberate and kept: reservations and principal
  loads may wait through a short spike. The chart's connection budget counts the rate pool per
  gateway replica from the value (`_helpers.tpl`; `charts/kobe/tests/db-connections.test.ts`
  44 → 48 at the defaults, a configured `ratePoolMax` followed; `docs/install.md`).
- **Member per-minute model rate** (`services/model-gateway/src/member-rate.ts`): `DbMemberRate`,
  key `kobe:model-rpm:<team>:<user>` (same team+user key as the old bucket), the old bucket's
  numbers (burst = the effective `requests_per_minute`, refilled at value/60 per second). One
  upsert per model request in `BudgetGate.admit` (once per request, never per stream chunk; the
  retry after Bifrost forgot a key does not re-admit). Same 429 `rate_limited` body;
  `Retry-After` = time until one request is available plus a jitter of up to one interval (at most
  1 s), so a member's throttled runs do not retry in step. The prune does not ride on the request
  (most members find a full bucket, which would add a DELETE to most calls): it runs in the
  background at most every 10 s per replica. A call refused right after by a budget gives its
  request back. Bifrost's per-key window stays as the backstop. `MemoryMemberRate` keeps the old
  in-memory bucket for unit tests.
- **Fail closed, and every model request now needs Postgres (review M2):** before, a Workspace
  without budget lines touched no database on a warm request and survived a short Postgres outage
  on cached state; now every request runs the upsert. Unreachable or slower than about 2 s → 503
  `rate_limit_unavailable` "The request-rate check is unavailable; retry shortly.",
  `Retry-After: 2`. The sandbox agent retries a 503 at most 8 times within 60 s per request
  (bounded); then the run fails with `model_unavailable` and the member sees "The model gateway is
  unavailable right now. Try again in a moment." in the conversation.
- **MCP App tool calls and card opens** (server): same per-user keys, `kobe:app-call:<user>` and
  `kobe:app-launch:<user>`, refilling buckets with the old numbers (burst 30 then 5/s; burst 5
  then 1 per 2 s), exact across server replicas; same 429 bodies. Postgres unreachable: the
  request fails (500; the call itself needs the database anyway, review L3 accepted).
- **`RequestRate` pruning** (`services/model-gateway/src/limits.ts`): past `maxSandboxes`
  (10,000) a new sandbox first drops full (idle) buckets, then the least recently used, like the
  server's `createRateLimiter`. No global reset.
- **Inventory correction:** the split listed "External scanner calls" as a per-replica memory
  limit; the code (`skills/registry/external-scan.ts:168`) counts running scans in Postgres under
  an advisory lock, so it is Site-wide. So 47 limits stay in memory by design, plus the gateway's
  `jti` replay set (documented per replica, owner's Q5 default).
- Comment drift fixed: `apps/call-deps.ts` no longer says launches share the app-call limit.
- **Prunes off the request (review R2-L4):** `backgroundPrune` in `@kobe/db` starts at most one
  prune per 10 s per limiter instance; the gateway's member rate and the server's two MCP App
  buckets use it. Fixed-window callers keep the inline prune on a new window (KOBE-809).
- `returnRateBucketToken`'s comment now says it does not clamp (a past TAT is a full bucket,
  review R2-L2).
- Not done (split Q3): a Helm NOTES warning when mcp-proxy or egress-proxy run more than one
  replica; their limits are documented per replica. Left for the coordinator to file if wanted.

## Bringing group-91 (KOBE-813) on top of this

group-91 adds `checkRateLimit`, `RateLimitVerdict`, `RateLimitDb` and `clearRateLimit` to
`services/server/src/rate-limit.ts`, with a copy of the fixed-window SQL. When it merges main
after this branch:

1. Take this branch's `services/server/src/rate-limit.ts` and drop group-91's SQL (the upsert,
   the prune `DELETE`, the `clearRateLimit` `DELETE`). `RateLimitDb` and `clearRateLimit` are
   already exported from here (re-exported from `@kobe/db`); `pruneExpiredRateLimits` already
   accepts a transaction.
2. Re-add `checkRateLimit` and `RateLimitVerdict` as a wrapper, same signature, so none of its
   callers change (but where a caller such as `admitOperation` forwards a `now` that defaults to
   `Date.now()`, make that default `undefined` too, or it brings back the pod clock):

   ```ts
   export async function checkRateLimit(
     db: RateLimitDb,
     key: string,
     rule: RateLimitRule,
     now?: number, // undefined: the database clock (KOBE-810); g91's `= Date.now()` must go
     options: { readonly prune?: boolean } = {},
   ): Promise<RateLimitVerdict> {
     const hit = await takeRateLimit(db, key, rule, {
       ...(now === undefined ? {} : { now }),
       onPruneError: logPruneError,
       ...(options.prune === undefined ? {} : { prune: options.prune }),
     });
     return {
       allowed: hit.allowed,
       retryAfterSeconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
     };
   }
   ```

   (`takeRateLimit` from `@kobe/db`; the non-finite `window_start` guard is moot: NOT NULL bigint.)
   `hitRateLimit` stays this branch's (it already delegates to `@kobe/db`).

3. `docs/rate-limits.md`: merge by hand. New rows use this branch's State vocabulary ("Postgres
   (`kobe_rate_limits`, key …)" or "Memory (pod), per replica"); keep the "Per replica by design"
   paragraph and the "Every model request needs Postgres" paragraph; do not bring back the removed
   gaps (in-memory limits multiply, bucket-map clear, comment drift).

## Docs

- `docs/rate-limits.md`: the limiter's two shapes (fixed window, refilling bucket), State column
  with storage and scope for every row ("Postgres … exact across replicas", "Memory (pod), per
  replica", "Memory (sandbox), per connection"), one "Per replica by design" paragraph, an "Every
  model request needs Postgres" paragraph (2 s fail-fast pool, 503, bounded sandbox retries), the
  three moved rows, the 10 missing limiters, scan-pool line ref, gaps 1, 2 and the comment-drift
  item removed, what the sandbox sees on `rate_limit_unavailable`.
- `docs/install.md`: the gateway's 2 extra connections in the connection table, rollout peak,
  `kobe-gateway-rate` application name.
- `docs/guide`: no change. No guide page mentions the per-minute model rate, the MCP App rates or
  model availability during a database outage; the limits now hold as configured, and the
  failure text a member sees already exists.
- No route or audit event added: `openapi.json` and the audit-events doc untouched.

## Evidence

- ac-1: `docs/rate-limits.md` (every in-memory row marked per replica / per connection, moved
  rows marked exact).
- ac-2: `services/model-gateway/src/member-rate.db.test.ts`: two gates on two pools share one
  bucket (18 concurrent calls at rpm 6 → 6 admitted, refusals `Retry-After: 10` = 60/6, not up to
  60); steady use at exactly 60/min for 3 minutes across both replicas never refused; a burst of
  10 then one request back after exactly 6 s (60/10), the full burst back after a minute, jitter
  adds at most 1 s; Postgres unreachable → 503. With the in-memory store (pre-change behaviour)
  the two-replica test admits 12. Gate unit tests (`budget-gate.test.ts`): fail closed, give-back.
- ac-3: `services/model-gateway/src/limits.test.ts` (idle buckets dropped, a spent active bucket
  kept; LRU when none idle).
- ac-4: measured in `member-rate.db.test.ts` (warm pool, database clock, dev Postgres over the
  LAN, 200 samples each): steady **p50 1.69 ms, p95 2.73 ms**; a member's first request into a
  full bucket **p50 1.62 ms, p95 2.05 ms** (the prune is not on the path); the background prune of
  100 expired rows **p50 1.80 ms, p95 2.09 ms**, at most every 10 s per replica. Before moving
  the prune off the path, the first request with the awaited prune measured p50 7.31 ms,
  p95 14.48 ms (machine under load). Against model calls of seconds, not measurable.
- Clock skew: "pods whose clocks are 5 minutes apart share one bucket" (gateway,
  `member-rate.db.test.ts`: 6 of 12 admitted, Retry-After ≤ 11 s, the pod ahead's prune keeps the
  debt) and "replicas whose clocks are 5 minutes apart" (server, `app-rate-limits.db.test.ts`:
  card-open bucket and fixed window). Run on pod clocks, the gateway case gives Retry-After 260 s
  and both server cases fail.
- Server: `services/server/src/apps/app-rate-limits.db.test.ts` (app calls: burst 30, one more
  after 200 ms, 5 more after 1 s; card opens: burst 5, one more after 2 s; both across two limiter
  instances on two pools; per-key reset; DB unreachable; bucket refusal wait and no charge;
  give-back; a hit inside a rolled-back transaction leaves no count; fixed-window time left).
  `team-apps`, `app-cards`, `app-launch-agent`, `rate-limit` DB tests, `src/apps` unit tests and
  `kobe-mcp/session-contract.test.ts` green.
- Gateway unit (260) and DB (30) suites, `@kobe/db` unit suite, chart `db-connections` test green;
  typecheck db, server, model-gateway clean; eslint, prettier, site wording, public hygiene clean.
