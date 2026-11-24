# KOBE-752: RN-8: repository rename, remotes, CI runner set, CLAUDE.md

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-126-rename-8-repo` in `../Kobe-g126`, on main after #722 (KOBE-751)
- **Spec:** `docs/specs/rename-kaiju.md` §4 step 7; tooling `scripts/rename/README.md`

## Outside the repository (done 2026-11-24, before this branch)

- GitHub repository renamed `SplittingAtom/kobe` → `SplittingAtom/kaiju` (GitHub redirects the old
  URL, so existing remotes, links and clones keep working).
- The ARC runner set's `githubConfigUrl` updated on the cluster; the coordinator's scripts updated.
- Repository variables: `gh variable list --repo SplittingAtom/kaiju` lists none, so
  `KOBE_RUNNER`/`KOBE_BUILD_RUNNER` were unset and nothing had to move.

## What changed (ac-2)

- **Hand work** (commit `chore: KOBE-752 rename hand work ...`):
  - `CLAUDE.md`, edited by hand: Kaiju as the product name, `charts/kaiju`, `kaiju-sandbox-agent`
    (the binary RN-3/RN-6 named: `images/sandbox/Dockerfile`, `@kaiju/sandbox-agent`), Kaiju Event
    Stream (as in `README.md`), and a short note that the product was called Kobe and why kept
    names remain (pointing at the allowlist and the guard). The pnpm filter examples already read
    `@kaiju/server` (RN-3). Kept, each checked to still exist under that name: Hadron project
    `kobe`, ticket ids, `kobe.team_id`, `kobe_reserve_budget` (migrations 0085/0091),
    `kobe.run_usage_retention` (migration 0239), `kobe.${purpose}`, `0047_budgets_rls.sql`.
  - Root package name `kobe` → `kaiju`. `pnpm install` left `pnpm-lock.yaml` unchanged (the root
    importer carries no name).
  - **Test databases on the shared dev Postgres** (`packages/db/src/test-support`): new throwaway
    databases and roles are `kaiju_<kind>_<hex>[_<lane>]`, the lane maintenance database
    `kaiju_lane_<lane>`. Lane listing and `test:lanes drop` cover `kobe_lane_*` and `kobe_*` objects
    too (a lane with both maintenance databases lists once); the stale-database sweep matches
    `^(kaiju|kobe)_(test|up)_<hex8>[_<lane>]$` with unchanged safety rules (older than a day, no
    session, plain `DROP DATABASE`). `laneFromDirectory` drops a leading `kaiju` or `kobe`, so the
    existing `Kobe-wt<N>`/`Kobe-g<N>` checkouts keep their lane names. Unit tests cover both
    prefixes, the refusals (`xkobe_…`, `kaijukobe_…`, roles) and the old directory names; the DB
    test of `dropTestLane` now also plants an old-named database.
  - Sandbox-agent `scripts/test-identities.sh`: transient group `kaiju-test-agent` (created and
    deleted by each run).
  - `docs/parallel-work.md`: lane section on the new names plus a "Names from before the rename"
    note; a line saying checkout directory names are the owner's choice (paths assume `../Kaiju`).
  - `ci/runners/README.md`: paragraph listing the kept runner infrastructure names and why.
- **Scripted** (`rename.mjs --apply --step RN-8`, its own commit): 60 occurrences in 13 files plus
  one path: `https://github.com/SplittingAtom/kaiju` in `charts/kaiju/Chart.yaml` (home, sources)
  and `ci/runners/values.yaml` (`githubConfigUrl`, comment), `ci/runners/README.md` `gh` commands;
  `.github/actions/setup-kobe` → `setup-kaiju` with every `uses:` and `paths:` trigger in seven
  workflows; `vars.KAIJU_RUNNER` / `vars.KAIJU_BUILD_RUNNER` in the workflows and docs;
  `../Kaiju-wt<N>` and `../Kaiju` in `docs/agent-prompt.md`, `docs/parallel-work.md`.
- **By hand after the apply:** one `--repo SplittingAtom/kobe` in `ci/runners/README.md` that the
  provisional Q3 entry (`/kobe` before a backtick) owned, so the step skipped it.
- No other repository URL exists in tracked files outside past ledgers and gate documents (kept,
  permanent group): no badges, issue links or `docs/guide` links. `.github/dependabot.yml` names
  no repository or `setup-kobe` path (its `/.github/actions` directory entry is unchanged).

## Kept (allowlist, permanent) and why

- **CI runner infrastructure** (new group): scale set and Helm release `kobe-k3s`, namespace
  `kobe-ci-runners` (also in the Docker Hub cache address in `values.yaml` and `e2e.yml`), Secret
  `kobe-arc-github-app`, GitHub App `kobe-arc-runners`, the nodes' `90-kobe-ci-inotify.conf`.
  These are live objects; renaming them means reinstalling the scale set and re-registering the
  App, which is infrastructure work, not this PR. CI runs on GitHub-hosted runners and no workflow
  selects the set (`KAIJU_RUNNER` unset).
- **Test database names from before the rename** (new group): the `kobe` alternatives in the lane
  helpers and the sweep, their tests and the docs note. Concurrent worktrees on older code keep
  creating `kobe_*` names; nothing on the shared server was dropped or renamed. Can go once no
  `kobe_*` test objects remain on the dev server.
- **Ticket-id branch form** `kobe-<N>-<slug>` in `docs/agent-prompt.md` and `docs/parallel-work.md`
  (added to the ticket-id group as its own entry; the existing entry's `\b` missed `<N>-`).
- **CLAUDE.md** names the old product once, to explain the kept names (new one-entry group).
- Worktree directories: the docs show `../Kaiju-wt<N>`, and say directory names are the owner's
  choice; existing `Kobe*` checkouts work unchanged (lane derivation strips either prefix).

## Allowlist

All five `== RN-8:` groups deleted; the step file now holds only the two groups it applied (repo
paths/URLs; runner variables and setup action) and names the hand work in its header. Guard: ok.
`node scripts/rename/guard.mjs --final` still reports 13 groups not done: provisional Q1, Q2, Q3,
Q4, Q5, Q6, Q7, Q8, Q10, Q11, Q12, Q13 and `RN-9` (test install names, KOBE-753).

## Checks (TMPDIR=~/tmp, one at a time)

- `pnpm install` (lockfile unchanged), `pnpm build`, `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`: all pass.
- `@kaiju/db` unit suite: 1113 passed (lane and sweep tests, and the repo guards that scan the
  whole tree). `@kaiju/sandbox-agent` has no unit change (its script runs in CI's
  privilege-separation step).
- `pnpm license:check`, `scripts/check-site-wording.mjs`, `scripts/check-public-hygiene.sh`, the
  rename guard and its self-test (23/23): all pass.
- Not run here: the DB suites (`lane.db.test.ts`, `sweep.db.test.ts`, `audit-upgrade.db.test.ts`,
  `upgrade.db.test.ts`) need the shared dev Postgres, which this ticket must not touch; CI's `db`
  job runs them against its own Postgres.

## User-facing docs

No change to `docs/guide/`: nothing a member, admin or in-sandbox agent sees changed. The guide
links nowhere to the GitHub repository, and the renamed items (repository URL in the chart
metadata, runner set config, CI variables and action, test database names, contributor docs) are
contributor and CI internals. The operator-facing chart `home`/`sources` URLs now point at the
new repository (the old one redirects).

## Open

- Renaming the runner scale set, its namespace, Secret and GitHub App is infrastructure work for
  the owner if ever wanted; the permanent group then moves with it.
- Old `kobe_lane_*` databases on the dev server go away as lanes are dropped
  (`pnpm --filter @kaiju/db test:lanes drop <lane>` now finds both prefixes).
