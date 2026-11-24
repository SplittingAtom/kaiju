# KOBE-750: RN-6: chart charts/kaiju, image names, publish and e2e workflows

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-124-rename-6-chart` in `../Kobe-g124`, stacked on `group-123-rename-5-wire` (KOBE-749, PR #720)
- **Spec:** `docs/specs/rename-kaiju.md` §3 change 4, §4 step 6, §5; tooling `scripts/rename/README.md`

## What changed

- **Narrowed before the apply** (commit `chore: KOBE-750 narrow RN-6`): the chart's
  `app.kubernetes.io/name` value moved into one helper (`kaiju.appName`, value still `kobe`); label
  keys `kobe.splittingatom.io/*` became permanent (owner decision, was Q9); new permanent groups
  for the selector label value and the Postgres database name `kobe`; the Bifrost admin user, the
  gallery agent key and the built-in connector in e2e, the sandbox Unix users in the Dockerfile and
  the orbit fixture's `kobe:` section joined their kept groups; the CI runner app and the runner
  hosts' sysctl file went to RN-8. The step file now repeats every RN-6 group (including the
  Triage tail, whose remaining forms are all in RN-6's areas), so only generated files were left.
- **Scripted** (`rename.mjs --apply --step RN-6`, its own commit): 3,398 occurrences in 522 files
  and 188 paths: `charts/kobe` → `charts/kaiju` (chart name `kaiju`, all helper defines
  `kaiju.*`), images `ghcr.io/splittingatom/kaiju-*` and local tags, `/opt/kaiju`,
  `/run/kaiju-{agent,pi,skills}`, `/var/run/kaiju`, `/var/run/secrets/kaiju`, `/etc/kaiju/extra-ca`,
  `/usr/share/doc/kaiju`, `kaiju-runas` (and its `KAIJU_*` compile-time macros with the `-D` flags
  in `scripts/test-identities.sh`), `kaiju-reclaim`, `kaiju-kernel-bridge.py` and its `_kaiju_*`
  kernel names, `PI_PRIVATE_PREFIX` `kaiju-pi-`, the egress shell's `__kaiju_egress_*`, the Pi
  extensions `kaiju-policy/-tools/-models/-exec` with their source directories, the Python
  packages `kaiju_orbit_eval`/`kaiju_skill_scan`, `*.kaiju.internal` sandbox host names, the
  e2e/dev/CI release, namespaces and clusters (`kaiju`, `kaiju-dev`, `kaiju-deps`, gate infra),
  publish, e2e, sandbox-image, orbit-eval, skill-scan and ci workflows, `scripts/check-images.sh`,
  the licence inventory, and docs (install, backup-restore, development, parallel-work, licensing).
- **By hand:** chart version 0.2.0; images' `third-party-licenses.json` path strings (what a refresh
  writes) and `pnpm licenses:update`; RN-6 groups deleted; `charts/kobe` in README and Tiltfile and
  `/opt/kobe` in the gate2 secret scan (both were held by a too-wide Q3 entry, now narrowed); the
  `*.kaiju.internal` line in install.md (held by Q4); reverts where the script was wrong: session
  token audiences `kobe.${a}` in chart tests and the session-key certificate CN (permanent), the
  database name in chart tests. CLAUDE.md is left to RN-8 (its group now also names
  `charts/kobe` and `kobe-sandbox-agent`), so this PR does not touch contributor instructions.
- **Found after the apply (RN-7 held them as object names):** the gate2, gate4 and gate-apps
  harnesses derived the sandbox image as `${SERVER_IMAGE/kaiju-server/kobe-sandbox}` (a CI-only
  failure); now `kaiju-sandbox`. Image names in two values comments and the inventory text too.
- **Fixed in passing:** the browser spec `code-completion.spec.ts` typed `kobe_li` while RN-3 had
  renamed the variable to `kaiju_live_value` (it would have failed in the browser suite).

## ac-1: in-place `helm upgrade` (decision and proof)

- **Selector labels keep `app.kubernetes.io/name: kobe`.** It was a literal in the chart (never
  derived from `.Chart.Name`), so the rename would have changed it; Deployment/StatefulSet selectors
  are immutable and the server's team NetworkPolicies select the chart's pods by these labels (the
  chart passes `kaiju.selectorLabels` into the server's sandbox config as `podLabels`). Not made a
  values key (owner: values keys do not change). Fresh installs get the same value.
- **Object names** derive from the release name (`kaiju.fullname`), so nothing is recreated:
  generated Secrets (auth, envelope key, session keys, internal keys), PVCs, the CNPG `Cluster`,
  Services, ServiceAccounts, hook Job names. Label keys, `postgres.appRole` `kobe_app` and the
  CNPG database `kobe` stay (a changed database name would point the app at an empty database).
- **Proof:** rendered the pre-rename chart (`charts/kobe` at the base commit) and the new chart for
  release and namespace `kobe` with `--is-upgrade` in three value sets (defaults; CNPG; ClamAV,
  skill scan, Rancher, ingress rate limit, reclaim, every workload at 3 replicas): object names,
  every `spec.selector`, NetworkPolicy pod selectors and peers, pod template labels, StatefulSet
  service names/volume claim templates and hook annotations are identical (59/62/72 objects).
  Committed as `charts/kaiju/tests/upgrade-selectors.test.ts` against the frozen fixture
  `tests/fixtures/pre-rename-upgrade.json` (names of stateful/looked-up objects, immutable
  selectors), plus a check that every label selector in the render uses `name=kobe` and that pods
  match their workload's selector; it fails (6 cases) when `kaiju.appName` is set to `kaiju`.
  The e2e upgrade shard (`54-chart-upgrade.sh`) upgrades within one chart version, so it does
  not cover this; the fixture test is the equivalent.

## Mixed rollout: sandboxes, Jobs and in-pod paths

- **Template carries image and paths together.** The server writes the sandbox image, mount
  paths (`/run/kaiju-agent/bootstrap`, `/run/kaiju-pi`, `/run/kaiju-skills`), the helper path
  (`KAIJU_PI_RUNAS=/opt/kaiju/bin/kaiju-runas`) and the `*.kaiju.internal` hostAliases into the
  same SandboxTemplate at the team reconcile (300 s). A template the old server wrote keeps the old
  image with the old paths; running and hibernated sandboxes resume from what they have; a sandbox
  picks up the new image and paths only together, when it restarts from the new template. Same
  reasoning as RN-4's env names. Nothing the server sends over the sandbox wire names an image path
  (checked), the proxies and gateway do not check the `*.internal` host names, and Pi's agent dir,
  git config and MCP config are rewritten per launch on tmpfs, so no persisted file holds them.
- **Agent-visible history:** a conversation started before the upgrade may mention
  `/run/kobe-skills/...` in earlier messages; the next run's prompt names the new paths. Accepted.
- **Eval Jobs** (separate image, started per eval): an old-image Job running across the upgrade
  calls `/kobe/eval-cases` and reports pack `kobe-default`. For one release the gateway serves both
  routes, the new image falls back to the old route on a 404 (old gateway pod mid-rollout), and
  the judge accepts both pack ids (permanent group "Pre-rename names served or accepted for one
  release", removed with KOBE-754). Skill-scan Jobs: result marker already dual (RN-4).
- **Unchanged on purpose:** team-namespace object names and their `app.kubernetes.io/name`
  values (`kobe-sandbox`, `kobe-skill-scan`; RN-7), Bifrost customer and admin names, the eval
  Job pod label is renamed (`kaiju-orbit-eval`; nothing selects it).

## Outside the repo (coordinator)

- **ghcr:** new packages `kaiju-{web,server,mcp-proxy,egress-proxy,model-gateway,sandbox}` and the
  chart `charts/kaiju` start private on first publish; set visibility like the `kobe-*` ones (not
  attempted here). orbit-eval and skill-scan are built by their workflows but not pushed by
  `publish.yml` (unchanged).
- **gate1 deploy script** (`~/.kobe-coord/deploy-gate1.sh`): image names `kaiju-<svc>:local-<sha12>`,
  chart path `charts/kaiju`, release unchanged (`helm upgrade kobe charts/kaiju ... --reset-values`;
  same values file). Import and **pin** the new `kaiju-*` refs on every node; unpin and remove the
  old `kobe-*` tags only after the team reconcile has moved every SandboxTemplate (else hibernated
  sandboxes still on old templates hit ImagePullBackOff).
- Local dev clusters named `kobe` keep working with `KAIJU_CLUSTER=kobe` (docs/development.md).
- Playwright runner or scripts that use `kubectl -n kobe-dev`, `svc/kobe-server` etc. follow
  their release name (gate1's release stays `kobe` until RN-9).

## Doc evaluation

- **Guide:** no change. Members and admins see no chart or image name; the Site admin isolation
  page's command now shows `charts/kaiju/runtimeclass-gvisor.yaml` (UI text, renamed by the script)
  and no guide page quotes it; no "For agents" page names an in-sandbox path that moved (`/home/kobe`
  stays, Q7). The eval result's pack id (`kaiju-default v1`) is not quoted in the guide.
- **Operators:** `docs/install.md` Upgrade notes bullet (chart/OCI location, image repositories,
  in-place upgrade command, kept label value, database name and label keys, in-pod paths and the
  sandbox/eval rollout); install commands use release/namespace `kaiju` for fresh installs and
  `<release>` for upgrades; `docs/releases/README.md` rename paragraph; `docs/development.md`
  (old dev cluster name).

## Evidence

One command at a time, TMPDIR on disk:

- `pnpm build`, `typecheck`, `lint` (incl. `helm lint --strict`), `format:check`: ok. Guard ok;
  self-test 23/23 (RN-6 samples updated); `pnpm license:check`, `check-site-wording.mjs`,
  `check-public-hygiene.sh` ok.
- Unit suites: chart 408 (incl. 10 new); sandbox-agent 1,294 (196 skipped: real-helper and real-Pi
  files, read by hand: `-DKAIJU_*` flags match the `.c`, extension paths `dist/kaiju-*`);
  server 4,572 (8 skipped); model-gateway 267; protocol 1,389; egress-proxy 182; mcp-proxy 174;
  license-check 86; web 4,313.
- DB suites: `@kaiju/server test:db` 3,751 passed; `@kaiju/db test:db` 2,180 passed.
- Sandbox image built once on a remote amd64 Docker host from this branch and
  `images/sandbox/test-image.sh` run against it: 81 checks ok, 0 failed (paths under `/opt/kaiju`,
  `kaiju-runas` capabilities and macros, the `kaiju-*` extensions, `kaiju-reclaim`, kernel bridge);
  test image removed afterwards. orbit-eval and skill-scan images not built here (CI).
- Not run here: browser suite, e2e gate scripts (CI and e2e per step).
