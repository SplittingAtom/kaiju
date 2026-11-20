# KOBE-698: Chart: opt-in egress NetworkPolicy for the server and web pods (SEC-9)

- **Status:** in review (group 50, branch `group-50-sec-platform`)
- **Branch / worktree:** `group-50-sec-platform` in `../Kobe-g50`
- **Depends on:** KOBE-699 (same branch)

## Decisions

- New template `server-web-networkpolicy.yaml` (beside the other per-component policy files)
  rather than more of `networkpolicies.yaml`: the two policies are opt-in and self-contained.
- `server.networkPolicy`: `restrictEgress` (default false), `allowedPorts` ([443]),
  `databasePeers`/`databasePort` (external Postgres; as `egressProxy.networkPolicy`),
  `kubernetesApi.peers`/`ports` ([443, 6443]; peers required, see the follow-up below; NetworkPolicy sees
  the API server after the Service DNAT and its address is cluster-specific), `extraEgress`.
  Allowed: DNS, Postgres (CNPG instances by selector, else databasePeers on the
  port), the release's bifrost/model-gateway/mcp-proxy/egress-proxy/clamav/embeddings pods (any
  port; each has its own ingress policy), the Kubernetes API, public IPv4 (private ranges
  excluded) on allowedPorts (S3, IdP, OAuth), the SMTP relay on `smtp.port` on public addresses,
  then extraEgress.
- `web.networkPolicy`: `restrictEgress` (default false), `extraEgress`; DNS and the server pods
  on 8080 (the default `web.serverUrl`).
- e2e: `e2e/run.sh` installs with both flags on for every shard except `gate1-prep` (the gates'
  fake IdP/OAuth servers are in-cluster), with `server.networkPolicy.extraEgress` for the
  kobe-deps fixtures (S3, SMTP) and the OTLP sink, the same rule a site with LAN S3/SMTP adds;
  a check asserts both policies exist. `KOBE_E2E_RESTRICT_EGRESS=0` turns it off.
- The default stays off (Chris decides on flipping it).
- `auth.sso.networkPolicy`'s comment and docs/install.md SSO text now point at the new flag.
- Docs: docs/install.md "Server and web egress (optional)" (flags, destinations, what to add to
  extraEgress: LAN S3, SMTP, IdP, telemetry, SIEM, with an example). No member/agent-visible change.

## Review follow-up (coordinator, 2026-11-20)

- `kubernetesApi.peers` and, with external Postgres, `databasePeers` are now required when
  `restrictEgress` is on: the chart fails with a message naming the key (template `fail`; the API
  peers also in values.schema.json via if/then, the database rule depends on `postgres.mode` so it
  stays in the template). "Any address on the port" admitted every LAN/cluster host on
  443/6443/5432. e2e/run.sh passes the k3d API server's endpoint IPs and the kobe-deps namespace.
  Chart test "refuses to render without…".

## Open questions (for Chris or the coordinator)

- Flip the default to on later? It needs every site to list LAN S3/SMTP/IdP first.

## Evidence (acceptance criteria → test or command output)

- ac-1: values.yaml, values.schema.json, `templates/server-web-networkpolicy.yaml`;
  `charts/kobe/tests/server-web-egress.test.ts` "is off by default".
- ac-2: same file: exact egress lists with the defaults, with peers/ports/extraEgress, with CNPG,
  and for web.
- ac-3: k3d e2e (suite shards run with both flags on) in CI after the push; not run locally (no
  local cluster engine).
- ac-4: docs/install.md section.
