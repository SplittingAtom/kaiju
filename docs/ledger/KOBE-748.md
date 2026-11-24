# KOBE-748: RN-4: environment variables KAIJU_* with one-release fallback and warning; chart templates; operator docs

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-122-rename-4-env` in `../Kobe-g122`, stacked on `group-120-rename-3-packages` (KOBE-747)
- **Spec:** `docs/specs/rename-kaiju.md` §3 change 5, §4 step 4, §5 (upgrade); tooling `scripts/rename/README.md`

## What changed

- **Narrowed before the apply** (commit `chore: KOBE-748 narrow RN-4`): the runas helper's
  compile-time macros (`KOBE_AGENT_UID`, `KOBE_SLOT_UID_MIN`, ... in
  `images/sandbox/runas/kobe-runas.c`) are not environment variables and pair with the `-D` flags
  in `services/sandbox-agent/scripts/test-identities.sh`: both now sit in the RN-6 image group
  (renaming one side broke CI in RN-3). The GitHub repository variable `vars.KOBE_BUILD_RUNNER`
  joins `KOBE_RUNNER` in RN-8 (repository settings, renamed with the CI secrets).
- **Scripted** (`rename.mjs --apply --step RN-4`, its own commit, nothing else): 3,740
  occurrences in 473 files (services, chart templates and tests, CI workflows, e2e scripts and
  gate harnesses, images' scripts, Dockerfiles and Python, Tiltfile, dev scripts, operator docs).
  The `RN-4` allowlist group is deleted; two lookbehinds in other groups now name `KAIJU_CLUSTER`
  and `KAIJU_BIFROST_ADMIN_PASSWORD`.
- **One helper:** `packages/protocol/src/node/legacy-env.ts`, exported as
  `@kaiju/protocol/legacy-env` (no Node imports, so the web's bundles can use it too).
  `resolveLegacyEnv` (pure), `adoptLegacyEnv` (moves `KOBE_X` to `KAIJU_X` in place when the new
  name is unset and deletes the old name either way), `legacyEnv(env, warn)` (for `loadConfig`:
  resolves and warns once per environment object, including names already adopted),
  `legacyEnvMessage`. The warning names old and new names, never values; a conflict says the new
  name is used. `@kaiju/db` and `@kaiju/cli` gained the `@kaiju/protocol` dependency (lockfile).
- **Wiring:** every service's `loadConfig(rawEnv, warn = logger.warn)` (server, sandbox-agent,
  mcp-proxy, egress-proxy, model-gateway) validates `legacyEnv(rawEnv, warn)`. Each entry point
  first calls `adoptLegacyEnv(process.env)`, so modules that read `process.env` later (telemetry,
  the server's per-feature settings, session-key loaders) and child processes (Pi, its extensions,
  tools, the executor) see only `KAIJU_*`, and an env-prefix filter never misses an old name. Web:
  `parseWebConfig` warns (`[kobe-web] ...`), then `instrumentation.ts` adopts before any request
  (the proxy's HSTS header reads `KAIJU_PUBLIC_URL`). Server CLIs (preflight, cold-start,
  lifecycle, sandbox, workspace-repair, thread-file-links backfill): `cli/legacy-env.ts`. Migrate
  and db-wait: env parsing moved to `packages/db/src/cli/env.ts` (testable). `kaiju` CLI:
  `adoptEnv` first in `main`.
- **Test database URL:** renamed to `KAIJU_TEST_DATABASE_URL` everywhere (CI workflows, turbo
  env, vitest configs, test-support, `e2e/memory-eval.sh`). `pnpm verify` first runs
  `scripts/check-test-db-env.sh`, which fails when only `KOBE_TEST_DATABASE_URL` is set (else the
  DB suites would be skipped silently); `testServerUrl()` says the same.
- **Chart:** templates, values and schema set only `KAIJU_*`; new `charts/kobe/tests/env-names.test.ts`
  checks every chart file and two renders (defaults; cnpg + telemetry + ClamAV). No Secret key
  name changed (keys are not env names; `secretKeyRef` keys untouched).
- **Allowlist:** a permanent group "Old environment variable names read for one release" holds
  the helper, the `KOBE_*` comments at the call sites, the tests, the test-DB check and the
  operator docs; removed with the fallbacks in KOBE-754 (RN-10). Self-test samples updated
  (an old name in a config file is unowned; the runas macro belongs to RN-6).

## Upgrade order (decision)

- **Chart ↔ services:** one release ships chart and images from one commit. During `helm upgrade`
  old pods keep the old chart's `KOBE_*` env with old images, new pods get `KAIJU_*` with new
  images; nothing mixed. A new image under an old env (rollback of the chart only, a pinned
  values file, hand-added env) works through the fallback. An old image under the new chart's env
  is not supported (it would read nothing); same as any chart/image skew.
- **Server ↔ sandbox pods and jobs:** the server writes only `KAIJU_*` into SandboxTemplates and
  Jobs. The template carries image and env together and the team reconcile (300 s) writes both at
  once, so a template written by the old server (old image, `KOBE_*`) stays consistent until then;
  running and hibernated sandboxes resume from whatever template they have. A new sandbox image
  started from an old template (`KOBE_*`) reads them through the fallback (the agent adopts before
  anything else, so Pi, extensions, `egress-env.sh` and tools inherit `KAIJU_*`). The reverse (old
  image, new env) cannot happen from the server, since it sets image and env from one config.
  Writing both names into sandbox pods was rejected: it would keep `KOBE_*` in the server for a
  release with no case that needs it.
- **Rollback** to the release before the rename: the old chart sets `KOBE_*` again; nothing is
  persisted under an env name (checked: no migration, seed or stored row names one).

## Left open / outside the repo

- Scripts outside the repository that set `KOBE_*` for e2e or tests need renaming when this lands
  (the gate1 deploy script, the Playwright runner's `KOBE_USER2`/`KOBE_PW2`, local
  `CLAUDE.local.md` copies naming `KOBE_TEST_DATABASE_URL`): e2e harness scripts read only the new
  names (dev tooling, no fallback), `pnpm verify` stops loudly on the old DB URL.
- Gate runbooks under `docs/gates/` and earlier specs keep the old names (history group, RN-1);
  their commands now need `KAIJU_*`.

## Doc evaluation

User guide: changed only where it quotes a variable an admin sets (`docs/guide/admin/single-sign-on.md`
break-glass command, `docs/guide/admin/site-admin.md` trusted proxies), both renamed by the
script; members and in-sandbox agents see no environment variable names, so no new guide page.
Operator docs: new `docs/install.md` section "Environment variable names (`KAIJU_*`)" (mapping
rule, one-release fallback, warning wording, what to rename, mixed rollout) and an Upgrade notes
bullet; the rename line in `docs/releases/README.md` (the place for unreleased notes) links it.

## Evidence

See the final section below (filled after the last run).
