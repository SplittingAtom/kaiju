# KOBE-715: Split the big closures in egress-proxy, mcp-proxy and server mcp/decide.ts (review CODE-29)

- **Status:** in review (group 56, branch `group-56-gateway-proxy-splits` in `../Kobe-g56`)
- **Depends on:** KOBE-714 (same method)

## Plan

Pure move/refactor, one commit per source file. No behaviour change: same checks in the same
order, same awaits, same error mapping, audit and metering.

## Decisions

- egress-proxy `proxy.ts` (722 → 146): types to `proxy-deps.ts` (with `HeaderOpener` and
  `UpgradeSettings`, re-exported from `upgrade.ts`/`proxy.ts`; `tunnel-registry.ts` imports from
  there, which removes the old proxy ↔ upgrade type cycle), `proxy-outcome.ts` (audit/span/log and
  blocked reports on a per-proxy `ProxyRuntime`), `proxy-connect.ts` (CONNECT set-up),
  `proxy-hello.ts` (ClientHello read, SNI check), `proxy-reply.ts`.
- egress-proxy `upgrade.ts` (730 → 300): `upgrade-headers.ts`, `upgrade-exchange.ts` (TLS connect
  and relay; the closure's counters/failure become a per-request `Relay` object), `upgrade-reply.ts`,
  `upgrade-types.ts`. Public names stay exported from `upgrade.ts`.
- mcp-proxy `upstream.ts` (538 → 162): `upstream-types.ts`, `upstream-connect.ts` (URL/address
  checks, pool), `upstream-wire.ts` (body/SSE reading), `upstream-session.ts` (sessions; the
  pending-DELETE count lives on a per-client `UpstreamTransport`).
- server `mcp/decide.ts` (662 → 533): `decide-types.ts`, `decide-records.ts` (audit, deny, skipped
  action, capture ticket), `decide-policy.ts` (policy input, `combineDecisions`); `decideMcpCall` runs
  stage functions over a per-call `Deciding` object (audit facts + denial). decide.ts stays slightly
  over 500 lines (not a new file).
- Test files not split (optional; none of the four needed internal imports moved).
- Docs: no user-facing change (internal refactor), so no `docs/guide` update.

## Open questions (for Chris or the coordinator)

None.

## Evidence (acceptance criteria → test or command output)

- ac-1: longest functions after: `openTunnel` 119, `exchange` 107, `upgrade` 89, `checkTool` 78,
  `post` 58 (before: `createEgressProxy` 408+, upgrade.ts `exchange` ~200, `createUpstreamClient`
  368, `decideMcpCall` 292).
- ac-2: egress-proxy unit 120 → 120 (proxy.test.ts, upgrade.test.ts), db 8 → 8; mcp-proxy unit
  156 → 156 (mcp.test.ts, upstream.test.ts); server `src/mcp` unit 8 → 8, db (mcp.db, mcp-exposure,
  mcp-proxy-gate2, kobe-mcp, app-results) 105 → 105; typecheck and lint green per package.
- Package checks (turbo test/typecheck/lint, the four packages): mcp-proxy 156, egress-proxy 120,
  model-gateway 255, server 3807 (+4 skipped) passed. A first run of kobe-mcp-site/-team db tests under
  heavy machine load hit 60 s hook timeouts (3 tests); both files passed alone (53/53, 42/42).
- `pnpm verify` (TMPDIR on disk, TURBO_CONCURRENCY=2): exit 0, including every package's test:db
  (server's took 53 min), license:check, hygiene and site wording.
