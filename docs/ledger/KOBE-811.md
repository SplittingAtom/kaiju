# KOBE-811: Optional rate limit at the ingress: Traefik middleware in the chart, off by default

- **Status:** in review (group 86, branch `group-86-rl-ingress`)
- **Branch / worktree:** `group-86-rl-ingress` in `../Kobe-g86`
- **Depends on:** none (docs/rate-limits.md arrives with PR #682; its "Chart and ingress" text is below)

## Plan

Values `ingress.rateLimit` (enabled, average, burst, period, `streams`, `ipStrategy`) render a
Traefik `Middleware` and attach it with `traefik.ingress.kubernetes.io/router.middlewares`; event
streams move to their own Ingress with their own middleware. Off: rendered output unchanged.

## Decisions

- **CRD apiVersion:** `traefik.io/v1alpha1`, fixed (k3s ships Traefik v3; `traefik.containo.us` is
  the deprecated v2 group). No `.Capabilities` detection: `helm template` in tests and CI has no
  CRDs, and detection would silently drop the limit.
- **How routes are found:** the chart has one standard `Ingress` (no IngressRoute): `/v1` and
  `/api/auth` to the server, `/` to the web. The browser calls `/v1` directly (no Next.js rewrite).
- **Long-lived connections:**
  - **SSE: own values.** The server's four SSE routes (`run-events.ts`, `skill-evals.ts`,
    `workspace-events.ts`, `workspace-changes.ts`, the modules importing `SSE_HEADERS`) are routed
    by a second Ingress `<release>-streams` with `router.pathmatcher: PathRegexp` and path
    `/v1/(runs/[^/]+/events|workspace/(events|changes)|skill-evals/[^/]+/events)$`; its rule is
    longer than `PathPrefix(/v1)`, so Traefik's default priority sends streams there. It carries
    `<release>-ratelimit-streams` (default 60/1m, burst 120) or nothing (`streams.enabled: false`).
    Traefik's rateLimit acts when a request starts, so open streams are never cut; the separate
    budget keeps EventSource reconnects from spending the page budget. A chart test fails when a
    new route module imports `SSE_HEADERS`, so the path list cannot drift silently.
  - **Sandbox WSS and MCP: excluded by construction.** `/v1/sandbox/connect` is served only on the
    server's sandbox listener (port 8081, refuses ingress forwarding headers) and the MCP proxy uses
    `/internal/v1/mcp` on port 8082; neither is in any Ingress (chart test asserts every Ingress
    backend is port `http`).
- **Source IP:** default no `sourceCriterion` (Traefik uses the connection's remote address).
  `ipStrategy.depth` or `ipStrategy.excludedIPs`; `excludeTrustedProxies: true` adds
  `auth.trustedProxies` (the `KOBE_TRUSTED_PROXIES` the server uses), so Traefik skips the same
  proxies. Setting depth with excluded IPs fails the render. Warning in values.yaml and install.md:
  SNAT in front of Traefik puts every client in one bucket; with an ipStrategy, a request without
  `X-Forwarded-For` counts against one shared empty source.
- **Second Ingress and cert-manager:** the streams Ingress reuses the TLS Secret but drops
  `cert-manager.io/*` annotations, so only the main Ingress owns the Certificate.
- **Operator middlewares:** a `router.middlewares` value in `ingress.annotations` is appended after
  ours on both Ingresses instead of producing a duplicate key.
- **Defaults** (when on): 100 per 1s, burst 300; streams 60 per 1m, burst 120. Generous because a
  page load fetches many `/_next` assets through the same limit.
- **Inventory:** no row needed; Traefik is already in `tools/license-check/inventory.yaml` (k3s
  bundled) and the chart adds no image.
- **User-facing guide:** no `docs/guide/` change; this is an operator-only chart value with no
  member, admin or agent visible surface (beyond 429s when an operator enables it). Documented in
  `docs/install.md` ("Rate limit at the ingress (optional)").

## Open questions (for Chris or the coordinator)

- Default stays **off** (ticket's default); Chris may prefer on.
- `PathRegexp` needs Traefik v3 (k3s 1.32+). Gates run k3s 1.34; the install prerequisite still says
  k3s 1.30. Not verified on gate1 (no deploy in this ticket).
- Traefik's behaviour for an empty `X-Forwarded-For` with an ipStrategy (shared empty key) is from
  Traefik's source as I recall it; worth a check on gate1 before recommending ipStrategy.

## Text for docs/rate-limits.md, section "Chart and ingress" (add after PR #682 merges)

> The chart can add a per-client-address limit at the ingress, off by default:
> `ingress.rateLimit.enabled: true` renders a Traefik `Middleware` (`traefik.io/v1alpha1`) with
> `average` requests per `period` and `burst` (defaults 100 per 1s, burst 300) and attaches it to
> every route of the Kobe Ingress. Event streams (`/v1/runs/<id>/events`, `/v1/workspace/events`,
> `/v1/workspace/changes`, `/v1/skill-evals/<id>/events`) go through a second Ingress with their own
> limit (`ingress.rateLimit.streams`, defaults 60 per 1m, burst 120; `enabled: false` leaves them
> unlimited), so stream reconnects do not spend the page budget and open streams are never cut. The
> sandbox WebSocket and the MCP proxy's routes never pass the ingress. Over the limit Traefik answers
> 429 before the request reaches Kobe; the application limits above still apply behind it. By
> default the client is the connection's remote address; behind a load balancer that hides client
> addresses set `ingress.rateLimit.ipStrategy` (`depth`, `excludedIPs`, or
> `excludeTrustedProxies: true` to skip the same proxies as `auth.trustedProxies`). See
> [Rate limit at the ingress](install.md#rate-limit-at-the-ingress-optional).

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ac-1 | `charts/kobe/tests/ingress-rate-limit.test.ts` "adds a traefik.io/v1alpha1 rateLimit Middleware…", "takes average, burst and period from values", ipStrategy cases                   |
| ac-2 | same file: "routes every SSE endpoint…to the streams Ingress", "knows every server route module that streams", "never exposes the sandbox WebSocket or internal (MCP proxy) ports"   |
| ac-3 | "ingress.rateLimit off (default)" cases; off render of the main Ingress identical to main (diffed with/without TLS, issuer, annotations); install.md section; rate-limits text above |
| ac-4 | schema cases ("refuses …" x8) and on/off describes; `pnpm --filter @kobe/chart test` 27 files / 370 tests passed; `helm lint --strict` on and off: 0 failed                          |
