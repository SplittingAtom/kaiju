# KOBE-694: allowedInternalCidrs must not override the always-denied ranges

- **Status:** in review (group 49, branch `group-49-sec-app`)
- **Branch / worktree:** `group-49-sec-app` in `../Kobe-g49`

## Decisions

- `AddressPolicy.check()` refuses `ALWAYS_DENIED_CIDRS` first, before `allowedInternal`.
- `validateInternalTargets` (now used by both proxies' and the server's
  `*_ALLOWED_INTERNAL_CIDRS`, SSO already used it) refuses an entry that starts in an
  always-denied range **or covers one wider than a single address** (`128.0.0.0/1`,
  `169.0.0.0/8`). Ranges holding only a single always-denied host (CGNAT with Alibaba's metadata
  address, ULA with AWS's) stay accepted; `check()` refuses that host. This also tightens
  `KOBE_EGRESS_INTERNAL_TARGETS` the same way.
- Chart: `$defs.internalCidr` in `values.schema.json` for the three `allowedInternalCidrs` lists.
  JSON-schema regexes cannot compute overlap exactly, so the schema is slightly stricter than the
  services: IPv4 /8 or narrower, IPv6 /16 or narrower except ULA (`fc..`/`fd..` /7 and /8).
- Tests ran fake upstreams on loopback through `allowedInternalCidrs: 127.0.0.0/8`, which no
  longer works. New seam: an optional injected `AddressChecker` (`createUpstreamClient`
  `addresses`, `ConnectorUrlPolicy.addresses`; the egress proxy already took one). Tests use
  `withTestLoopback()` from the new `@kobe/address-policy/testing` export. Not reachable from
  any config.
- Tracked tests use `192.168.10.4/30` as the example private /30 (not the test install's range).

## Docs

`docs/install.md`: Egress internal targets, MCP connectors, SSO network section, upgrade note.
No guide change (operators only).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/address-policy/src/index.test.ts` ("never lets allowedInternal re-open…",
  incl. `::ffff:` mapped addresses); `services/mcp-proxy/src/upstream.test.ts` (listed loopback
  still refused).
- ac-2: `services/mcp-proxy/src/config.test.ts`, `services/egress-proxy/src/config.test.ts`,
  `services/server/src/connectors/config.test.ts`.
- ac-3: `charts/kobe/tests/internal-cidrs.test.ts` (three lists; private /30, 10/8, 172.16/12,
  100.64/10, fd00::/8 pass; 19 bad entries refused).
- ac-4: `docs/install.md` (above).
