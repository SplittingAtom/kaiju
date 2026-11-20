# KOBE-693: mcp-proxy internal routes on their own port, registered URLs only, split keys

- **Status:** in review (group 49, branch `group-49-sec-app`)
- **Branch / worktree:** `group-49-sec-app` in `../Kobe-g49`
- **Depends on:** KOBE-694 (same files in the proxy)

## Decisions

- Proxy: `createApp(deps)` is the sandbox-facing listener (health, `/v1/mcp`) on `PORT` 8080;
  `createInternalApp(probe, appCalls)` serves `/internal/v1/probe` and `/internal/v1/app-calls` on
  `KOBE_MCP_INTERNAL_PORT` (default 8081, must differ from `PORT`).
- Registered URL: probe bodies now carry `connector_id` (app calls already did). The proxy asks
  the server's internal listener `GET /internal/v1/mcp/connectors/:id/endpoint` (proxy key, no
  sandbox token; non-deleted connectors) and refuses any other URL (403 `url_not_registered`,
  503 `registry_unavailable`) before contacting the upstream. URLs are compared after `new URL()`
  normalization. `ConnectorProbe.probe(url, apiKey, connectorId)`; pinning and refresh pass it.
- Keys: Secret `<release>-mcp-proxy-internal` keeps `key` (proxy -> server) and gains
  `routes-key` (server -> proxy), generated with the same `lookup`-and-keep pattern, so a
  `helm upgrade --reset-values` from the current chart adds it with no manual step. Env:
  proxy `KOBE_MCP_ROUTES_KEY`, server `KOBE_MCP_PROXY_ROUTES_KEY`, both `optional: true`
  secretKeyRefs: an operator's own `internalKeySecret` without `routes-key` falls back to the one
  key in both services (proxy logs a startup warning).
- NetworkPolicy: team namespaces -> 8080 only; server pods -> 8081 only (server no longer reaches
  8080). Service gains port `internal` 8081; server `KOBE_MCP_PROXY_URL` -> `:8081`.
- Rollout window: while only one of server / proxy has rolled, probes and app calls fail
  (key or port mismatch); sandbox MCP calls are unaffected.

## Docs

`docs/install.md` (MCP connectors paragraph, upgrade note), `values.yaml` comment. No guide
change: nothing a member, admin or agent sees changes.

## Open / not verified here

- The `lookup` upgrade path cannot run in `helm template`; the template keeps `key` via the same
  expression as before and adds `routes-key` only when absent. Worth one `helm upgrade` on the
  test install.
- ac-5 (e2e connector flows: probe, refresh, app call) needs a deployment; not run here.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/mcp-proxy/src/probe.test.ts`, `app-calls.test.ts` (sandbox-facing app: 404 for
  `/internal/*`, nothing reaches the upstream).
- ac-2: `charts/kobe/tests/mcp-proxy.test.ts` (ingress: team namespaces 8080, server pods 8081;
  container and Service port).
- ac-3: `services/mcp-proxy/src/registered-url.test.ts`, probe/app-call tests (other URL,
  unknown connector, registry down); `services/server/src/mcp.db.test.ts` (endpoint route);
  `connectors/probe.test.ts` (connector_id sent).
- ac-4: chart test (two distinct generated keys, optional refs for an own Secret);
  `services/mcp-proxy/src/config.test.ts`, `services/server/src/config.test.ts` (fallback).
- ac-5: not run (see above).
