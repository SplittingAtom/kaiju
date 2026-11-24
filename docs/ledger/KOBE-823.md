# KOBE-823: Repo-wide guard tests inside @kobe/db can replay a cached pass when only files elsewhere change

- **Status:** in review (committed on the branch, not pushed; the coordinator lands it)
- **Branch / worktree:** `group-118-guard-cache` in `../Kobe-g118`, from main `910d5b0b7`

## Finding: real locally, not (today) in CI

`team-setters.test.ts` and `run-usage-retention-setting.test.ts` scan every tracked file
(`git ls-files`) but run in `@kobe/db`'s `test` task, which Turbo keys on `packages/db` only (it
has no workspace dependencies). Evidence, a violation planted in
`services/server/src/k823/plant.ts` (`set_config('kobe.team_id', $1, true)`), in a scratch commit
dropped afterwards:

| Step                                                                | `@kobe/db#test` hash | `@kobe/server#test` hash |
| ------------------------------------------------------------------- | -------------------- | ------------------------ |
| `turbo run test --filter=@kobe/db --filter=@kobe/server --dry=json` | `36b13689f87dccf5`   | `0cd31a3f601b7045`       |
| plant uncommitted (`git add -N`)                                    | `36b13689f87dccf5`   | `03669000e6dd5124`       |
| plant committed                                                     | `36b13689f87dccf5`   | `03669000e6dd5124`       |

Then, cache warmed without the plant, plant committed, `turbo run test --filter=@kobe/db`:
`cache hit, replaying logs 36b13689f87dccf5`, 1 cached, exit 0. The same file run directly
(`vitest run src/team-setters.test.ts`) fails both scans naming `services/server/src/k823/plant.ts`.
So `pnpm verify` (`turbo run test`) on a developer machine passes a planted violation.

**CI:** not affected as built today. Every job restores `.turbo/cache` from main
(`.github/actions/setup-kobe`), but the only writer is ci.yml's `static` job on main, which starts
from an empty cache (`turbo-cache: none`), runs `pnpm build` only and saves right after it; no job
runs tests before a save, and there is no remote cache (`TURBO_TOKEN` unused). The restored cache
therefore never holds a `test` entry and `unit`'s `pnpm test` always runs `@kobe/db#test`. That is
an accident of where the save step sits, not a guarantee: moving the save after the tests, or a
remote cache, would make CI replay the pass too.

## Fix

`turbo.json`: a package task `@kobe/db#test` with `"cache": false` (same `dependsOn`/`outputs` as
`test`). Chosen over repo-wide `inputs` (hashing the whole tree on every run, and a whole-tree glob
is easy to get wrong) and over moving the guards to root scripts (more churn, the same effect): the
whole `@kobe/db` unit suite takes ~2 s, so running it on every `pnpm test` / `pnpm verify` / CI run
costs about 2 s. Guard code, allowlists and file paths unchanged. New
`packages/db/src/repo-guards-uncached.test.ts` fails if the override is dropped (it caught exactly
that once during this work). CLAUDE.md non-negotiables: one bullet saying so.

Proof (warm cache, plants committed in scratch commits, dropped after):

- `turbo run test --filter=@kobe/db --dry=json`: resolved `cache: false`, status `MISS`.
- Team plant: `cache bypass, force executing`; both team-setters scans FAIL; turbo exit 1.
- Plus `"kobe.run_usage_retention"` planted in `services/server/src/k823/plant2.ts`, CI's form
  `pnpm test --filter=@kobe/db --concurrency=2 -- --maxWorkers=3`: the retention scan and both team
  scans FAIL, exit 1.
- Plants removed: two runs in a row, both `cache bypass`, 31 files passed.

ac-1 shown locally with a warm cache and CI's invocation (not on a CI runner: nothing is pushed).
ac-2: CI's `unit` job runs `pnpm test` on every push and merge-group run; the task can no longer be
served from any cache.

## Other guards and cross-package readers checked

Searched every test for `git ls-files`, repo-root walks and reads outside its package; hashes
checked with `--dry=json` after a one-line edit (reverted) to the file read.

| Check                                                                                                       | Reads                                                                    | Status                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `scripts/check-site-wording.mjs`, `scripts/check-public-hygiene.sh`                                         | apps/services/packages; all tracked files                                | fine: root scripts, never cached (CI `static`, `pnpm verify`)                                  |
| `license:check` (tools/license-check, inventory via `git ls-files`)                                         | repo                                                                     | fine: `cache: false` in turbo.json                                                             |
| `scripts/osv-audit.test.mjs`                                                                                | its script                                                               | fine: `node --test` in security-audit.yml, no Turbo                                            |
| `services/server/src/threads/team-filter.test.ts`                                                           | `packages/db/src`, `services/server/src`                                 | fine: a `packages/db` edit changes `@kobe/server#test`'s hash (db is a dependency)             |
| `charts/kobe/tests/ingress-rate-limit.test.ts`                                                              | `services/server/src/routes`                                             | fine: a routes edit changes `@kobe/chart#test`'s hash (server is a dependency)                 |
| `apps/web/components/shell/text-link-rule.test.ts`                                                          | root `eslint.config.js`                                                  | fine: a Turbo global dependency                                                                |
| `packages/db/src/audit/events.test.ts`                                                                      | `docs/audit-log.md`                                                      | fixed by this change (`@kobe/db#test` uncached)                                                |
| `apps/web/lib/admin/api/site/audit-categories.test.ts`                                                      | `packages/db/src/audit/events/`                                          | weak locally: web does not depend on db; an events edit left `@kobe/web#test`'s hash unchanged |
| `apps/web/lib/admin/nav/registry.test.ts`                                                                   | `docs/ledger/`, `docs/RUN-LEDGER.md`                                     | weak locally: ledger edits leave the hash unchanged                                            |
| `charts/kobe/tests/backup-secrets.test.ts`, `scheduler.test.ts`, `models.test.ts`                           | `docs/backup-restore.md`, `dev/values.yaml`, `images/bifrost/Dockerfile` | weak locally: outside every package (docs edit: hash unchanged)                                |
| sandbox-agent tests (egress, git, notebook, reclaim, Pi parity), `apps/web/lib/notebooks/variables.test.ts` | `images/sandbox/**`                                                      | weak locally: `images/sandbox/egress-env.sh` edit left both hashes unchanged                   |
| `services/server/src/agents/eval/pack.test.ts`, `testing/memory-eval/*`                                     | `images/orbit-eval/scenarios/`, `e2e/fixtures/`                          | weak locally: outside every package                                                            |

The "weak locally" rows are consistency checks between a package and a file it does not own, not
repo-wide security guards; in CI they always run (no test entries in the restored cache). Not
changed here; a follow-up could add those paths as `inputs` in the packages' `turbo.json` (as
`packages/guide/turbo.json` does for `docs/guide/**`). Not filed (agents do not touch Hadron).

## Docs

No guide change: nothing a member, admin or in-sandbox agent sees or can do changes (build/test
configuration only).

## Verification

`pnpm build`, `pnpm verify` (format, lint, typecheck passed; its test step stopped on two
`@kobe/skill-scanner` `bypasses.test.ts` timeouts at 10 s / 6.6 s under parallel load, a package
this change does not touch, which passed 180/180 alone), then `pnpm test --concurrency=2` (29/29),
`pnpm license:check`, `scripts/check-public-hygiene.sh`, `scripts/check-site-wording.mjs`,
`pnpm format:check`: all pass. `test:db` not run (no database URL; nothing database-backed changed).
