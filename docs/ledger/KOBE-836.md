# KOBE-836: Old-name settings warning lists Kubernetes service-link variables

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (branch only; no push or PR from the ticket agent)
- **Branch / worktree:** `group-127-service-link-env` in `../Kobe-g127`, based on main `7469d137d`
- **Related:** KOBE-748 (RN-4, the `@kaiju/protocol/legacy-env` helper), removed with the
  fallbacks in KOBE-754 (RN-10)

## Problem

Kubernetes injects service-link variables for every Service in the pod's namespace
(`enableServiceLinks`, on by default). On the test install the Services are named `kobe-*`, so
pods saw `KOBE_SERVER_SERVICE_HOST`, `KOBE_MCP_PROXY_PORT_80_TCP_ADDR`, `KOBE_WEB_PORT=tcp://…`
and so on. The helper took them for old settings: it copied them to `KAIJU_*` and logged a warning
naming about 80 variables that the operator cannot rename.

## What changed

- **Helper** (`packages/protocol/src/node/legacy-env.ts`): new `serviceLinkNames(env)` finds the
  `KOBE_*` service-link variables. It first collects the services from `KOBE_<SVC>_SERVICE_HOST`
  names whose value is an IPv4 or IPv6 address, then accepts a `KOBE_<SVC>_…` variable only when
  name and value have the kubelet's shape:
  `SERVICE_HOST` = IP; `SERVICE_PORT[_<NAME>]` = number; `PORT` = `tcp|udp|sctp://ip:port`
  (IPv6 in brackets); `PORT_<n>_<TCP|UDP|SCTP>` = URL of that protocol; `…_ADDR` = IP,
  `…_PORT` = number, `…_PROTO` = `tcp|udp|sctp`. Without an IP-valued `SERVICE_HOST` sibling
  nothing is skipped, so a real setting with a coincidental name still falls back and warns.
  `resolveLegacyEnv` passes these variables through unchanged under their own names and leaves
  them out of the report; `adoptLegacyEnv` neither copies nor deletes them (they are not ours).
- **Chart** (`charts/kaiju`): `enableServiceLinks: false` on every pod: the shared Deployment
  template (`_helpers.tpl`: server, web, mcp-proxy, egress-proxy, model-gateway, scheduler, ...),
  bifrost, clamav, embeddings, the migrate Job (`_migrate.tpl`) and the isolation preflight Job.
  New test `tests/service-links.test.ts`.
- **Sandbox pods:** already set it. `services/server/src/sandbox/manifests.ts` (SandboxTemplates),
  `agents/eval/job.ts` and `skills/registry/external-scan-job.ts` have had
  `enableServiceLinks: false` since before this ticket; no change.

## Decision: enableServiceLinks off on chart pods (done)

Checked that nothing reads service-link variables (`git grep` for `_SERVICE_HOST`,
`_SERVICE_PORT`, `_PORT_<n>_TCP` and `<SVC>_PORT` across services, apps, packages, images and the
chart): services reach each other by DNS name from explicit `KAIJU_*` settings the chart renders
(`KAIJU_CLAMAV_HOST`, `KAIJU_MCP_PROXY_URL`, ...). The only Kubernetes variables used are
`KUBERNETES_SERVICE_HOST/PORT` (the server's `loadFromDefault()` in-cluster config), which the
kubelet injects for the API server regardless of `enableServiceLinks`. The third-party images
(Bifrost, ClamAV, llama.cpp) are configured by file, args and explicit env.

Turning them off also prevents the same problem under the new prefix: with a release named
`kaiju`, Services `kaiju-*` would inject `KAIJU_SERVER_PORT=tcp://…`, `KAIJU_CLAMAV_PORT=tcp://…`
and similar into the `KAIJU_` namespace the services read (today the chart's explicit
`KAIJU_CLAMAV_PORT` wins, but any future setting named `KAIJU_<component>_PORT` would collide).

The helper fix is still needed: operators may run an older chart (or roll the chart back without
the images) and get the service links injected.

## Tests

- `packages/protocol/src/node/legacy-env.test.ts`, block "Kubernetes service-link variables":
  - **ac-1:** a realistic env built the way the kubelet writes it (kobe-server with named ports
    `http` and `internal`, web, mcp-proxy, egress-proxy with two unnamed ports, model-gateway on
    an IPv6 ClusterIP, bifrost, clamav; 60+ variables) gives an empty report, no warning, no
    `KAIJU_*` copies, and `adoptLegacyEnv` leaves the object unchanged.
  - **ac-2:** real old names beside those links (`KOBE_PUBLIC_URL`, `KOBE_SMTP_PORT`, a
    `KOBE_S3_BUCKET` conflict) still warn and fall back exactly as before; the message names no
    service-link variable.
  - Look-alikes are kept as settings: no `SERVICE_HOST` sibling, a sibling whose value is a host
    name, or a value of the wrong shape (`KOBE_SERVER_PORT=8080`, wrong protocol, `ADDR` not an IP).
- `charts/kaiju/tests/service-links.test.ts`: every rendered pod (defaults; clamav + skill scan +
  cnpg) has `enableServiceLinks: false`; covers the pods outside the shared template. Fails on main
  (checked by stashing the template changes).

## Docs evaluation

- `docs/install.md` ("Environment variable names") gains a paragraph: service-link variables are
  not settings, are never renamed or warned about, and chart and server-created pods turn them off.
  Operator-facing only.
- `docs/guide/` (members, admins, in-sandbox agents): no change. Nothing a member, admin or agent
  sees or can do changes; sandbox pods already had no service links, and the warning only ever
  appeared in service logs.

## Checks

TMPDIR=~/tmp, one at a time, all green: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `@kaiju/protocol` unit suite (79 files, 1392 tests), `@kaiju/server` unit
suite (341 files passed, 2 skipped; 4587 tests), chart tests (35 files, 431 tests) and
`helm lint --strict`, `node scripts/rename/guard.mjs` (after one allowlist line for the `kobe-*`
Service names in the helper's comments, its tests and `docs/install.md`, in the KOBE-748
permanent group), `scripts/check-public-hygiene.sh`.
