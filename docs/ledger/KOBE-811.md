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
- **Traefik v3 required (review M1):** `PathRegexp` exists only in Traefik v3. With the limit on,
  the render fails below Kubernetes 1.32 (`semverCompare "<1.32-0" .Capabilities.KubeVersion`,
  k3s before 1.32 ships Traefik v2); `ingress.rateLimit.assumeTraefikV3: true` overrides for a
  self-managed Traefik v3. Stated in values.yaml, the install prerequisites and the install section.
  Chart tests pin `--kube-version` so they do not depend on the helm client's default.
- **Source IP (review M2):** default no `sourceCriterion` (Traefik uses the connection's remote
  address). Stock k3s ServiceLB with `externalTrafficPolicy: Cluster` hides client addresses (one
  bucket per node): values.yaml and install.md say to set `externalTrafficPolicy: Local` first
  (HelmChartConfig snippet in install.md) and check the address Traefik sees. `ipStrategy` (depth,
  or excludedIPs / `excludeTrustedProxies` adding `auth.trustedProxies`) is documented only for an
  L7 proxy that always adds `X-Forwarded-For`; the earlier "have the load balancer send
  X-Forwarded-For" advice for k3s was removed (ServiceLB is layer 4). Warning: with an ipStrategy
  and no usable address the whole Site shares one bucket (confirmed by review from Traefik v3.6
  `pkg/ip/strategy.go`). Render fails on depth plus excluded IPs, and on `excludeTrustedProxies`
  with nothing to exclude (review L4).
- **Address validation (review L2):** `excludedIPs` entries must match a strict IPv4 or IPv6
  address/CIDR pattern in the schema; the template applies the same check to the merged list, so a
  malformed `auth.trustedProxies` entry also fails when `excludeTrustedProxies` would pass it to
  Traefik (a bad entry would otherwise break the Middleware and 404 every route).
- **Stream regex anchoring (review L3):** anchored only at the end (Kubernetes requires a leading
  `/`, so no `^`); `/x/v1/workspace/events` also matches and gets a 404 from the server. Harmless;
  noted in `_ingress.tpl`.
- **Second Ingress and cert-manager:** the streams Ingress reuses the TLS Secret but drops
  `cert-manager.io/*` annotations, so only the main Ingress owns the Certificate.
- **Operator middlewares:** a `router.middlewares` value in `ingress.annotations` is appended after
  ours on both Ingresses instead of producing a duplicate key.
- **Defaults** (when on): 100 per 1s, burst 300; streams 60 per 1m, burst 120. Generous because a
  page load fetches many `/_next` assets through the same limit.
- **Inventory:** no row needed; Traefik is already in `tools/license-check/inventory.yaml` (k3s
  bundled) and the chart adds no image.
- **Site console notice (Chris, 2026-11-22):** the limit stays off by default; the Site console
  overview shows Site admins an informational notice when no ingress limit is configured. The
  chart sets `KOBE_INGRESS_RATE_LIMIT` on the API server (`chart` when `ingress.enabled` and
  `rateLimit.enabled`; else `external` when `ingress.rateLimit.external: true`, the operator's
  declaration of their own edge limit; else `none` with the chart's Ingress; else `unknown`),
  validated by zod in `config.ts` (default `unknown`). There was no Site health surface yet, so
  this adds `GET /v1/site/health` (`site.settings.manage`, `{checks: [...]}`, one check
  `ingress_rate_limit`: `level` `ok` with `source`, or `info` with `state` `none`/`unknown` and
  `docs`) and `SiteHealthNotices` on the Site console overview (owner/admin only; `Notice` tone
  info, `role="status"`, link to the guide section). OpenAPI catalog detail added, openapi.json
  regenerated, route inventory snapshot updated.
- **User-facing guide:** `docs/guide/admin/site-admin.md` gains "Ingress rate limit" (what the two
  notices mean, who can act, `ingress.rateLimit.external`); the chart values themselves are
  operator-only and documented in `docs/install.md` ("Rate limit at the ingress (optional)", now
  with the notice and `external`).

## Open questions (for Chris or the coordinator)

- Default stays **off** (ticket's default); Chris may prefer on.
- Not deployed to gate1 in this ticket (gate1: k3s 1.34, Traefik 3.6, Traefik Service already
  `externalTrafficPolicy: Local`, per the review).
- ac-3 done: the text below was added to `docs/rate-limits.md` (2026-11-22).

## Text for docs/rate-limits.md, section "Chart and ingress" (add after PR #682 merges)

> The chart can add a per-client-address limit at the ingress, off by default:
> `ingress.rateLimit.enabled: true` renders a Traefik `Middleware` (`traefik.io/v1alpha1`) with
> `average` requests per `period` and `burst` (defaults 100 per 1s, burst 300) and attaches it to
> every route of the Kobe Ingress. Event streams (`/v1/runs/<id>/events`, `/v1/workspace/events`,
> `/v1/workspace/changes`, `/v1/skill-evals/<id>/events`) go through a second Ingress with a
> separate budget (`ingress.rateLimit.streams`, defaults 60 per 1m, burst 120; `enabled: false`
> leaves them unlimited), so stream reconnects do not spend the page budget; open streams are never
> cut. The sandbox WebSocket and the MCP proxy's routes never pass the ingress. Over the limit
> Traefik answers 429 before the request reaches Kobe; the application limits above still apply
> behind it. It needs Traefik v3 (k3s 1.32 or later; the chart refuses older clusters unless
> `assumeTraefikV3: true`). **Before enabling on k3s**, set the Traefik Service to
> `externalTrafficPolicy: Local`: with the default `Cluster`, ServiceLB hides client addresses and
> every user shares one budget per node. Leave `ingress.rateLimit.ipStrategy` empty unless an L7
> proxy in front of Traefik always adds a trusted `X-Forwarded-For`; with it set and no usable
> address, the whole Site shares one budget. While no limit is configured the Site console shows
> Site admins an information notice; `ingress.rateLimit.external: true` declares an edge limit of
> your own and hides it. See [Rate limit at the ingress](install.md#rate-limit-at-the-ingress-optional).

## Evidence (acceptance criteria → test or command output)

| AC     | Evidence                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1   | `charts/kobe/tests/ingress-rate-limit.test.ts` "adds a traefik.io/v1alpha1 rateLimit Middleware…", "takes average, burst and period from values", ipStrategy cases                                                                                                                                                                                               |
| ac-2   | same file: "routes every SSE endpoint…to the streams Ingress", "knows every server route module that streams", "never exposes the sandbox WebSocket or internal (MCP proxy) ports"                                                                                                                                                                               |
| ac-3   | "ingress.rateLimit off (default)" cases; off render of the main Ingress identical to main (diffed with/without TLS, issuer, annotations); install.md section; rate-limits text above                                                                                                                                                                             |
| ac-4   | Traefik v3 version gate (refuses 1.30/1.31, renders 1.32, override, off unchecked); schema cases ("refuses …" x13) and on/off describes; `pnpm --filter @kobe/chart test` 27 files / 382 tests passed (34 in the new file); `helm lint --strict` on and off: 0 failed                                                                                            |
| notice | `services/server/src/routes/site-health.test.ts` (admin only; chart/external ok; none, unknown info), `config.test.ts` (env values, default unknown, refusal), `apps/web/components/admin/overview.test.tsx` "site health notices" (none, unknown, configured, non-admin not asked), chart "KOBE_INGRESS_RATE_LIMIT…" (none/chart/external/unknown, server only) |
