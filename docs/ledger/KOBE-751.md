# KOBE-751: RN-7: team namespace prefix as configuration

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-125-rename-7-k8s` in `../Kobe-g125`, stacked on `group-124-rename-6-chart` (KOBE-750, PR #721)
- **Spec:** `docs/specs/rename-kaiju.md` §3 change 7, §4 step 6, §5; tooling `scripts/rename/README.md`

## What changed

- **Hand work first** (commit `feat: KOBE-751 team namespace prefix as configuration ...`):
  - Chart value `sandbox.teamNamespacePrefix`, schema enum `""`, `kaiju-team-`, `kobe-team-`.
    `kaiju.teamNamespacePrefix` (templates/\_sandbox.tpl) resolves it; the server gets it in
    `KAIJU_SANDBOX_CONFIG` (`teamNamespacePrefix`, a required `z.enum` in `sandbox/config.ts`).
  - Server: `TEAM_NAMESPACE_PREFIXES` and `sandboxNames(prefix)` in `sandbox/constants.ts` replace
    the fixed names. One **naming generation** per prefix (`kaiju-team-` → `kaiju-*`,
    `kobe-team-` → `kobe-*`): ServiceAccount, template, warm pool, the three NetworkPolicies, the
    three quotas, LimitRange, RoleBinding, eval template/pool/PriorityClass, bootstrap volume,
    pod `app.kubernetes.io/name` values, `managed-by` value and the server-side-apply field
    manager. Every builder takes the settings; nothing can pick a name outside the prefix's
    generation, so namespace and object names cannot mix.
  - Chart copy: the skill eval PriorityClass is `<generation>-skill-eval` (`kaiju.sandboxGeneration`).
- **Start-up check** (`sandbox/namespace-prefix.ts`): lists namespaces labelled
  `kobe.splittingatom.io/team-namespace=true`; any not under the configured prefix stops the
  server and the scheduler (`startup/server.ts`) with a message that names the value ("Set the
  Helm value sandbox.teamNamespacePrefix to "kobe-team-" ... and upgrade again"). An unreachable API only logs a warning; the provider runs the same check
  once per process before it converges or creates any team namespace (fail closed,
  `provider/team.ts` `checkPrefix`).
- **Scripted** (`rename.mjs --apply --step RN-7`, its own commit): 166 occurrences in 45 files:
  the fresh-install names in tests, the e2e and gate scripts, `e2e.yml` debug steps and
  `docs/install.md`. The step file now also repeats the object-name group (patterns excluding
  chart templates and `constants.ts`); both RN-7 groups were deleted from the allowlist.
- **Allowlist:** new permanent group for the kept `kobe-team-` generation (exact quoted forms in
  constants, the chart helper, values, schema, admission comment; the tests of the kept
  generation; the e2e probe namespace); the Bifrost team name `kobe-team-${teamId}`
  (`models/desired.ts`, stored in Bifrost, not a namespace) joined the Bifrost permanent group;
  the install.md and development.md upgrade notes joined the upgrade-note group. Self-test cases
  updated (23/23).

## Decisions

- **Detection: Helm `lookup` in the chart, backed by the server check.** The admission policies are
  a security control that must know the prefix at render time, and the server must not write its
  own admission policy, so server-side detection alone cannot work. Rule (`kaiju.resolveTeamNamespacePrefix`):
  the value when set; else, when the cluster is reachable (`kaiju.online`), the prefix of the
  existing labelled team namespaces (both present: fail), `kaiju-team-` when none; offline
  (`helm template`, Argo CD, Flux, client-side `--dry-run`) the render **fails** unless the value is
  set or `global.allowGeneratedSecretsOffline` marks a throwaway environment (same precedent as
  generated secrets). A reachable render also fails when labelled namespaces exist outside the
  resolved prefix. So a GitOps upgrade cannot silently switch the admission policies to the wrong
  prefix, and the server check covers whatever a render could not see.
- **Exactly two prefixes, no free-form value:** a free prefix would let the admission policy that
  confines the server's cluster-wide namespace writes cover namespaces Kaiju never created.
- **Admission self-check now also proves agreement:** the dry-run refusal must name the server's
  own prefix (`may only manage <prefix>* namespaces`); a policy rendered for the other prefix
  refuses provisioning with its own message. The probe namespace is `kaiju-admission-probe` on both
  generations (a dry run, never stored; outside both prefixes).
- **Site admin Teams page:** the slug hint no longer prints `kobe-team-<slug>` (the web app does not
  know the prefix); it says the slug becomes part of the sandbox namespace name.

## ac-3: RBAC and NetworkPolicies

- **RBAC** (`sandbox-rbac.yaml`, `rancher.yaml`): no rule names a namespace or a team object; only
  comments changed. Cluster-wide verbs stay confined by policy 1 of `sandbox-admission.yaml`.
- **Admission policies:** all four pin `startsWith('<prefix>')` for the one configured prefix
  (test: the other prefix never appears in any policy).
- **Proxy NetworkPolicies** (egress-proxy, mcp-proxy, model-gateway, `networkpolicies.yaml`): select
  team namespaces by the permanent label, never by name: unchanged on both generations (test).
- **Server-side:** `teamOfNamespace`, the isolation reconciler and the eval reaper skip namespaces
  outside the prefix; the bootstrap-token identity regex is pinned to the prefix and the
  generation's ServiceAccount (test: `kaiju-team-*` or `kaiju-sandbox` tokens refused on a
  `kobe-team-` install); existing namespaces are still adopted only with the matching team-id label.
  Nothing was widened to cover "either prefix".

## ac-1: fresh vs upgraded install

- **Chart** (`tests/team-namespace-prefix.test.ts`, 18): resolver cases on made-up namespaces
  (fresh, kept, label-only, both, mismatch, foreign, offline, throwaway), full renders per prefix
  (config, admission, PriorityClass), RBAC/NetworkPolicy unchanged, generations equal `kobe-*`
  names existing installs have.
- **Server** (`provider-prefix.test.ts`, `namespace-prefix.test.ts`, 14): a `kobe-team-` install
  converges its existing namespace under `kobe-*` names only, same claim and PVC uid, no deletes;
  a fresh install writes only `kaiju-*`; a `kaiju-team-` server on a `kobe-team-` cluster creates
  nothing and names the value; admission/server mismatch refused.
- **e2e** (`run/54-chart-upgrade.sh`): the upgrades there reuse values with an empty prefix, so the
  chart looked it up: asserts the deployed prefix stays `kaiju-team-`, the team namespace and its
  quota keep their uids, a labelled `kobe-team-*` probe namespace makes a server-side dry-run
  upgrade fail naming both prefixes, and the server creates nothing in it. The k3d shard
  cannot express a pre-rename install (no old release to upgrade from).
- **Left for the live gate1 upgrade:** the usual `helm upgrade ... --reset-values` of release
  `kobe` with the value unset (online, so detected): check `KAIJU_SANDBOX_CONFIG` says
  `kobe-team-`, the policies pin `kobe-team-`, PriorityClass `kobe-skill-eval` not replaced, log
  `team namespace prefix checked`, team reconcile `failed:0`, unchanged uids of team namespaces,
  quotas and workspace PVCs, no `kaiju-*` object in `kobe-team-*`, sandboxes wake. RN-9 then
  installs fresh (`kaiju-team-`).

## Mixed rollout

Old and new server pods on an upgraded install use identical names and field manager (the kept
generation is exactly the old fixed names), and the re-rendered admission policies are identical,
so a rolling upgrade has no mixed window. A fresh install has no old pods.

## Open

- A throwaway render (`allowGeneratedSecretsOffline`) against a cluster with `kobe-team-*` gets
  `kaiju-team-`: the server refuses to start, but until the value is fixed the admission policies
  guard `kaiju-team-*`, not the old namespaces (defence in depth only; RBAC, the server's own
  isolation checks and its refusal stand). Documented; production renders cannot get there.
- Dev clusters from before the rename: delete the old release's team namespaces
  (`docs/development.md`).

## Doc evaluation

- **Guide (`docs/guide/`):** no change. Members and agents never see namespace or object names;
  the only UI change is the Site admin Teams page slug hint (no longer shows a namespace name),
  which no guide page quotes.
- **Operators:** `docs/install.md` Sandboxes section (new "Team namespace prefix" paragraph; names
  and commands now say `kaiju-*`, with how to read them on a kept install) and an Upgrade notes
  bullet; chart `values.yaml` comments; `docs/development.md` (old dev clusters).

## Evidence

One command at a time, TMPDIR on disk:

- `pnpm build`, `typecheck`, `lint` (incl. `helm lint --strict`), `format:check`: ok. Guard ok;
  self-test 23/23; `check-site-wording.mjs`, `check-public-hygiene.sh` ok.
- Unit: server 4,587 passed (8 skipped); chart 426; web 4,313.
- `*.real.test.ts` / `*.real-pi.test.ts`: none build sandbox settings or team names (checked).
