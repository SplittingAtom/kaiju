# KOBE-747: RN-3: packages, binaries, file paths, identifiers, log fields; lockfile and licence inventory

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-120-rename-3-packages` in `../Kobe-g120`, stacked on `group-119-rename-2-text` (KOBE-746, PR #708)
- **Spec:** `docs/specs/rename-kaiju.md` §3 changes 3, §4 step 3; tooling `scripts/rename/README.md`

## Counts

| Owner (guard `--report`)  | Before (base `19370ec52`) | After                   |
| ------------------------- | ------------------------- | ----------------------- |
| RN-3                      | 14,653 in 2,960 files     | 0 (groups deleted)      |
| all allowed occurrences   | 58,700                    | 44,951                  |
| provisional (Q1–Q13)      | 1,784                     | 2,251                   |
| permanent                 | 33,751                    | 34,013                  |
| RN-5 / RN-6 / RN-7 / RN-8 | 775 / 3,622 / 225 / 110   | 851 / 3,643 / 228 / 185 |

- **Scripted** (`rename.mjs --apply --step RN-3`, commit `1bf39f671`, nothing else in it): 13,924
  occurrences in 2,885 files and 76 paths (`git mv`), after the triage tails were narrowed (commit
  `584faaca9`, below). The step file now ends with catch-all patterns for the three `Triage:`
  groups: they rename only what those groups still owned once every value that stays had a kept or
  later-step entry.
- **Regenerated:** `pnpm-lock.yaml` by `pnpm install` (35 package names). `pnpm licenses:update`:
  inventory up to date (first-party packages are not listed; `THIRD_PARTY_LICENSES.md` and `NOTICE`
  unchanged). The sandbox image's `third-party-licenses.json` names `@kaiju/protocol` (rewritten by
  the `@kobe/` pattern; a fresh `collect-licenses.sh` + `image-report` on the built image left it unchanged). CSS snapshots and the route inventory match without
  regeneration (renamed together with their sources). `audit:doc`: up to date. OpenAPI is not tracked.
- **By hand** (commits `39f96cff5`, `4ddd07c81`): about 230 word edits in about 130 files: test values the catch-all renamed that pair
  with kept code values (connector id and names, publisher, gallery key, Pi provider id, Bifrost
  names, orbit export names, escaped regex forms such as `kobe\.team_id` and `kobe\.model_error`),
  identifiers a pre-existing kept entry held back (`.kobe` in `?.kobe` and `...kobe`), two imports
  my Q13 entry held back, the three remaining connection application names, prettier re-flow.

## Narrowed before the apply (commit `584faaca9`)

What the `Triage:` tails held that must not change in this step, each with a reason in the group:

- **permanent:** rate-limit keys `kobe:` in `kobe_rate_limits` (new group: old and new pods share
  the rows during a rolling upgrade); the SSO cookie AEAD labels (`kobe-sso-state-v1`, ...) and the
  HKDF salt; the SCIM token prefix `kobe_scim_` (issued tokens are checked against it); signed tool
  names `kobe.project_notes.add`/`.suggestion`; the trace-span KDF info; the throttle key's hash
  label and the memory fence HMAC label; Bifrost key, virtual-key, admin-user and provider names
  (`kobe-<id>`, `kobe-vk-…`, `kobe-embed-stub`); the git conversion marker in repository
  descriptions; the `kobe_listen_probe` channel; the `kobe_backup` role in docs; the session-token
  audience prefix strip; the memory lint, which now recognises both names (`kobe|kaiju`).
- **Q3 (KOBE-826):** the site-settings API fields `kobeMcpMode`, `kobeReadsPerMinute`,
  `kobeWritesPerHour` (public API, asserted by e2e) and the `{ kobe: … }` team-connector response;
  builtin kind and names `kobe`, `kobe-builtin`, `kobe-git`, `kobe-git-builtin`; the internal MCP
  route segment; `mcp__kobe_builtin__`/`mcp__<kobe>__` segments; the admin tool-call id fallback.
- **Q8 (KOBE-831):** publisher `kobe` (enum, SQL checks, seeds), `not_kobe`/`kobe_skill` error
  codes, the scanner name `kobe-skill-scanner`, the catalog `kobe` API field, tool source `kobe`.
- **Q4 (KOBE-827):** `kobe-moved/`, the `/kobe-branch-summary` Pi command and UI titles,
  `kobe-context.json`, custom entry types `kobe-memory-picks`/`kobe-sync-conflict`, `.kobe-sync-`
  temp files in workspaces, the Pi provider id `kobe` (model ids `kobe/…`, `models.json`).
- **Q2 / Q6 / Q7 / Q11 / Q13:** manifest key `compatibility.kobe`; `kobe-reference:` and
  `not_allowed_in_kobe` (MCP Apps); the `kobe` user comment; orbit export name `kobe-<slug>-v<n>`;
  the gallery agent's file `gallery/agents/kobe.ts`, `gallery-kobe.db.test.ts`, its key `kobe`.
- **Type names in the OpenAPI document** (`KaijuTeamConnector`, `KaijuSkillReset`, ...) change with
  the types: generated API clients see new component names, field names do not change.
- **Q1:** references to `docs/specs/kobe-admin-mcp.md` ("spec kobe-admin-mcp §n").
- **RN-5:** telemetry attributes the tails held (`kobe.turns`, `kobe.usage_kind`, …), tracer names,
  OTel service name `kobe-${service}` (e2e 42 asserts it), syslog APP-NAME/SD-ID and their test,
  cookies `kobe-sso`/`kobe-sso-link`, Better Auth plugin ids, storage keys, `x-kobe-` prefix, realms.
- **RN-6:** `/tmp/kobe-pi*` runtime paths (the e2e probe reads them), the egress-env message, the
  image prefix in `check-images.sh`, chart Job names `kobe-migrate(-initial)` (named after the
  release), `helm install kobe`, the dev cluster name, the database name `kobe` in docs.
- **RN-7:** namespace `kobe-admission-probe`. **RN-8 (new group):** test database and role names
  on the shared dev Postgres (`kobe_lane_<lane>`, `kobe_test_…`, swept by name, named after the
  repository like the lanes) and the dev machine's `kobe-test-agent` group.

## Found by the DB suites (fixed)

- **`byKobe`** (three schema properties): Drizzle's `snake_case` casing maps it to the column
  `by_kobe`, and the identifier pattern renamed it to `byKaiju` (`by_kaiju`), which no migration
  has. Build, typecheck and unit suites were green; the probe suite and `pnpm db:check` caught it.
  It is back to `byKobe` everywhere, with a permanent entry next to `kobeShippedVersion`. No other
  camelCase schema property holds the name. Lesson for later steps: run `pnpm db:check`.
- Bifrost provider names in budget tests (`kobe-${provider}/m`, `kobe-unpriced/m`) and a publisher
  value went back to `kobe`.

## Binaries (decision)

- `@kaiju/db` ships `kaiju-migrate` and `kaiju-db-wait`, `@kaiju/cli` ships `kaiju`. The chart never
  calls the bin names: its migrate Job and wait init container run
  `node node_modules/@kaiju/db/dist/cli/{migrate,wait}.js`, which change **in this step** with the
  package (chart command lines are code, not cluster object names; the image built from the same
  commit holds `node_modules/@kaiju/db`). e2e scripts use `/app/node_modules/@kaiju/db/...` likewise.
  One release ships chart and images from one commit, so each step deploys on its own; no dual name.
- The sandbox agent has no bin entry: `kobe-sandbox-agent` is its image path (`/opt/kobe/...`) and
  OTel service name, both RN-6 (spec §3 changes 4 lists it under packaging).
- Log `service` fields: `kaiju-migrate`, `kaiju-db-wait` (the other services log `server`,
  `egress-proxy`, …). Postgres `application_name`s are all `kaiju-*` now (operator docs updated).

## Self-test

RN-3's groups are deleted; the real-allowlist test now asserts that package imports, renamed files
and test values are unowned, and that escaped regex forms belong to the value they spell.
`DISTINCT_VALUES` lost the entries whose RN-3 half is gone; `kobe-sign-in-throttle` added.

## Doc evaluation

User guide: changed, because a user-visible command changed: the break-glass command in
`docs/guide/admin/single-sign-on.md` is now `kaiju sso allow-local-sign-in`, and
`docs/guide/for-agents/working-with-git.md` quotes the sandbox's `kaiju: SSH is not available`
message. Developer and operator docs (`CLAUDE.md` commands, `docs/backup-restore.md`,
`docs/install.md`, `docs/theming.md`, `docs/audit-log.md`, package READMEs) name `@kaiju/*`,
the `kaiju` CLI and `kaiju-*` application names. Environment variables still read `KOBE_*` (RN-4).

## Review round 1 (merge after fixes): what changed

- **H1:** the Pi redirect plants (`testing/redirect-plants.ts`) planted provider `kaiju` while Pi's
  provider id stays `kobe` (KOBE-827): the control test failed with Pi installed and the "refused"
  cases passed vacuously. The plants, the variant names and the agent test's `set_model` now take
  the id from `KAIJU_PROVIDER_ID`, so they cannot drift again. Real-Pi tests run here now (below).
- **M1:** back to the kept values: `mcp__kobe_builtin__…` (fallback connector segment), model ids
  `kobe/fast`/`kobe/deep`, `kobe-mac-mini`, and the git branch names in host-contract, probe and
  policy tests (`kobe/feature`, …); each has an explicit allowlist entry in its group.
- **L1:** HMAC-era token fixtures derive with the historical `kobe/run-token/v1` and
  `kobe/server-call-token/v1` again (permanent: signed labels of retired tokens).
- **L2:** comments name `Kobe-Sandbox-Token` until RN-5 (the RN-5 header entry is now
  case-insensitive); the delegation forgery tests send both `kobe-delegation` and
  `kaiju-delegation` (permanent group for forgery tests).
- **L3:** the `service` and `application_name` changes and the CLI name are in the install guide's
  Upgrade notes, linked from the rename line in `docs/releases/README.md`.
- **L4:** `data-kobe-builtin-connector`, `data-kobe-git-change`, `data-kobe-guide-body`,
  `data-kobe-sync-conflict`, `--kobe-threads-col` and `#kobe-threads-file-rail` (held only by
  unrelated kept entries) are renamed with their unit-test and e2e selectors.
- Checks after the fixes: guard ok, self-test 23/23, build, typecheck, lint, format:check,
  `db:check` ok. With the pinned Pi installed: sandbox-agent 1,427 passed, 2 failed (the known
  `runtime-dir.test.ts` pair), 58 skipped; the real-Pi files alone: 118 passed, 0 failed, 7
  skipped (the partner-uid cases need the sudo test identities), the redirect control included.
  server 4,565 (8 skipped), web 4,288, protocol 1,373, db 1,106, session-token 24, model-gateway
  260, egress-proxy 180; DB: probe 927, the two touched server DB files 24.

## Evidence

Final run on `4ddd07c81` (the ledger commit changes only this file):

- `pnpm build`, `typecheck`, `lint`, `format:check`, `license:check`, `db:check` (no schema
  changes): ok. Guard ok (44,951 allowed, 214 entries); self-test 23/23; `check-site-wording.mjs`
  and `check-public-hygiene.sh` ok; gate2's generic secret patterns and JWT shape match none of the
  902 lines added under `services/sandbox-agent`, `images`, `packages/protocol`.
- Unit suites, one package at a time: protocol 1,373; db 1,106; address-policy 16; agent-file 68;
  cli 98; guide 33; session-token 24; skill-scanner 180; telemetry 32; egress-proxy 180; mcp-proxy
  170; model-gateway 260; license-check 86; chart 395; sandbox-agent 1,289 passed, 2 failed (the
  known `runtime-dir.test.ts` pair on this machine), 196 skipped; web 4,288; server 4,565 passed,
  8 skipped.
- DB suites: `@kaiju/db test:db` 2,180 passed; `@kaiju/server test:db` 3,739 passed (earlier runs
  also: `@kaiju/cli` 49, `@kaiju/egress-proxy` 31, `@kaiju/model-gateway` 8).
- Images (remote amd64 Docker host, plain `docker build`, test images removed afterwards): server
  image built, runs as `1000:1000`, holds `node_modules/@kaiju/db/dist/cli/{migrate,wait}.js` and
  no `@kobe`; `wait.js` starts and logs `service: kaiju-db-wait`. Sandbox image built;
  `images/sandbox/test-image.sh` 81/81 ok; its licence report regenerated with no diff.
- Not run here: the browser suite and the e2e gate scripts (they change in this step: `@kaiju/db`
  paths in e2e scripts, renamed spec file `kaiju-admin-mcp.spec.ts`, CSS classes and data
  attributes).
