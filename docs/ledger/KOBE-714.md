# KOBE-714: Split model-gateway gateway.ts into gateway/ modules (review CODE-9)

- **Status:** in review (group 56, branch `group-56-gateway-proxy-splits` in `../Kobe-g56`)
- **Depends on:** none

## Plan

Pure move/refactor (review SPLIT-8, CODE-32 for the test file). No behaviour change.

## Decisions

- `createModelGateway` keeps only the server setup; the request path is module functions in
  `gateway.ts` (`handle`, `serveInference`, `admitCall`, `forwardWithRetry`) that take a
  per-gateway `{ options, upstream }` and a per-request `RequestState` (`gateway/usage.ts`),
  replacing the closure's `let`s. Nothing became module-level mutable state.
- New siblings in `src/gateway/`: `options.ts` (`GatewayOptions`, re-exported from `gateway.ts`),
  `auth.ts`, `errors.ts`, `read-body.ts`, `eval-cases.ts`, `prepare-body.ts`, `forward.ts`
  (Bifrost transport, per-attempt state), `usage.ts` (state + metering in the old `finally`).
  `run-attribution.ts` now imports `GatewayOptions` from `gateway/options.ts` (removes a type cycle).
- Test split: `gateway.test.ts` (1059) → `gateway.test.ts` (authentication, routing, calls),
  `gateway-runs.test.ts` (run tokens, review hardening, virtual keys), `gateway-tracing.test.ts`
  (tracing, eval cases) on `testing/gateway-harness.ts` (excluded from the build). The six
  assignments to harness state became setter calls (`setPrincipal`, `setGate`, …); no assertion changed.
- Docs: no user-facing change (internal refactor), so no `docs/guide` update.

## Open questions (for Chris or the coordinator)

None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `gateway.ts` 1063 → 390 lines; largest new file `gateway/forward.ts` 277. Longest function
  before `createModelGateway` 754 (`handle` 393); after `serveInference` 94.
- ac-2: gateway tests 41 → 41 (3 files); model-gateway unit 255 → 255; db (model-gateway.db,
  two-replicas-site.db, server-call-budget.db, …) 25 → 25; typecheck, lint green.
- `pnpm verify` (TMPDIR on disk, concurrency 2): format, lint, typecheck, test all green; test:db green
  for db, cli, egress-proxy, model-gateway; `@kobe/server:test:db` was still running (no failures) when
  my 50-minute guard stopped it (unrelated to this package); license:check, hygiene, site wording ok.
