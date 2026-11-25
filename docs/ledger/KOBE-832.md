# KOBE-832: RN-19: git branch prefix kaiju/ for new branches; agent file section kaiju: written, kobe: still read

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-137-rename-19-branches` in `../Kobe-g137`, stacked on
  `group-136-rename-18-values` (KOBE-831, PR #733)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answers A10 and A11; tooling `scripts/rename/README.md`

## What changed

- **Narrowed before the apply** (commit `chore: KOBE-832 RN-19 step patterns`): the step file
  repeats both RN-19 groups; two stale comments (`--model kobe/<gateway model>` in
  `kaiju-models/index.ts` and `pi-launch.ts`, the Pi provider is `kaiju` since KOBE-827) were
  renamed with them; the one real pre-rename provider mention in `testing/redirect-plants.ts`
  moved to the KOBE-827 permanent group.
- **Scripted** (`rename.mjs --apply --step RN-19`, its own commit): 35 occurrences in 21 files.
  `pullRequestBranch()` (`services/server/src/git/repo-commit/naming.ts`) now builds
  `kaiju/<member>/<message>-<7 hex>`; the export writes `metadata.kaiju` and names the experiment
  `kaiju-<slug>-v<n>`; the Orbit fixtures, test data (protocol, web, db probe, sandbox agent,
  git host contract, git tools) and the admin guide line follow.
- **Orbit section, both names read** (`services/server/src/agents/orbit/orbit-schema.ts`):
  `ORBIT_METADATA_KEY = "kaiju"`, `PRE_RENAME_ORBIT_METADATA_KEY = "kobe"`,
  `orbitKaijuSection(metadata)` returns the section under either name, or refuses both with
  `BOTH_METADATA_SECTIONS_MESSAGE` ("…Keep `kaiju:` only…"). `orbitExperimentSchema` (the
  server's twin of Orbit's loader, also run on every export) refuses a file with both. The
  export uses the constant.
- **Eval image** (`images/orbit-eval/kaiju_orbit_eval/cli.py`): the loader of an exported file
  (in the eval Job and for anyone running the image on a downloaded file) refuses both sections
  with the same text, exit 2; either one alone is accepted (Orbit's loader keeps `metadata` as
  free-form). New fixtures `agent-pre-rename.yaml` (`kobe:`) and `agent-both-sections.yaml`,
  checked in `test-image.sh`.

## Findings (no code change needed)

- **One open pull request per member per Repo** is the `git_commit_branches` row keyed by
  (team, project, user), not a branch-name match: `openBranch()` (`commit.ts`) asks the host for
  the stored pull request's state by number and pushes to the stored branch, whatever its prefix.
  So a stored `kobe/` row with an open pull request takes the member's next commits, no second
  pull request opens under `kaiju/`, and once it is merged or closed the next commit opens a
  `kaiju/` branch and replaces the row. Status (`GET /v1/projects/:id/repo-status`) shows the
  stored branch as is.
- **Stored rows are not migrated.** A branch under an open pull request can't be renamed on
  GitHub/Gitea/Forgejo, and the row must keep naming the real branch. The rows are read as
  stored, so the old prefix is read for good while any old branch can exist (documented in the
  upgrade note and the permanent allowlist group).
- **Cleanup:** Kaiju has no branch cleanup: nothing deletes branches on a host (the adapter has
  no delete; conversion and mirror push only the default branch). So it can never delete a
  branch it doesn't own; the guide says to delete merged ones on the host.
- **Branch-name parsing, webhooks, polling:** nothing parses Kaiju's branch names (no code reads
  the prefix); there are no webhooks (spec workspace-git §10) and the mirror polls only the
  default branch.
- **Agents' git tools:** `git_create_branch` takes any name the agent chooses (no prefix rule);
  the tool descriptions and prompts never named the prefix. Tests that used `kobe/x`-style
  names now use `kaiju/`.
- **Provider adapters and e2e:** the GitHub/Gitea/Forgejo fakes and adapters match no prefix
  (the shared contract test only used `kobe/feature` as a sample name, renamed); no e2e Forgejo
  or git fixture names the prefix (checked `e2e/`).
- **Agent file import trust fields** (KOBE-831 review): the agent file (`parseAgentFile`, strict
  frontmatter: name, role, description, icon, model, skills, connectors, tools, approval_mode,
  starters) carries no `source`, `scope` or publisher; tool `source`/`scope` exist only in the
  tool manifest the server computes at publish. Nothing imports an Orbit file into Kaiju: the
  export is one-way and its `metadata` is never read back as agent data.

## Decisions

- **"Import" of the Orbit file = the readers of an exported file:** the server's schema and the
  eval image's loader. Neither existed for the section before; both now take either name and
  refuse both, as A11 asks. No new import feature was added.
- **The both-present refusal sits in the schema, not only the reader,** so the export itself can
  never write both (it can't today) and the server and the image agree on the message.
- **Rolling upgrade:** pods of the previous release keep naming new branches `kobe/` during the
  roll; such rows are handled exactly like pre-rename ones (upgrade note).

## Allowlist

- Both RN-19 groups removed. New permanent group "Names in members' git repositories and in
  downloaded agent files from before the rename…" (placed above the rate-limit group, whose
  `kobe:`-then-backtick entry would otherwise own the section name in messages): the reader
  constants and messages, the pre-rename tests and fixtures, the guide and upgrade lines; every
  entry file-scoped and anchored.
- `testing/redirect-plants.ts` comment added to the KOBE-827 group.

## Tests

- `orbit-export.test.ts`: export writes `kaiju:` and never `kobe:`; a `kobe:` file and a
  `kaiju:` file parse and read; both refused with the message at `metadata`.
- `git-repo-commit.db.test.ts` "pull requests opened before the rename": first commit on a
  `kaiju/` branch; the branch and row are turned into the pre-rename `kobe/` state; the next
  commit joins pull request #1 on the `kobe/` branch (one pull request on the host, no `kaiju/`
  branch made); after the merge the next commit opens #2 on `kaiju/`, the old branch is left
  alone, status follows.
- Existing: the `^kaiju\/…` assertion in the first Repo commit test, `tree-edit.real-git.test.ts`
  (`pullRequestBranch`).
- Eval image: `test-image.sh` cases for the pre-rename file (accepted) and both (exit 2);
  run locally against the pinned Orbit 1.0.3 in a venv (`--validate-only`: bash fixture ok,
  pre-rename ok, both refused rc=2); the image build runs in CI.

## Docs evaluation

Members, admins and agents see the branch name (Commit result, pull request on the host,
`commit_project` result) and admins download the Orbit file, so the guide changes (ac-3):

- `docs/guide/admin/git-organizations.md`: new branches `kaiju/…`; old `kobe/` branches keep
  their names and pull requests, one open pull request per member per Repo, never deleted.
- `docs/guide/files/workspaces-and-projects.md` (Commit… on a Repo) and
  `docs/guide/for-agents/working-with-git.md` (`commit_project` on a Repo): the branch name and
  that an open pre-rename pull request keeps taking commits.
- `docs/guide/agents/agents.md`: new **Export to Orbit** paragraph (the file, its `kaiju:`
  section, old `kobe:` files still read, both refused). No guide page described the export
  before.
- `docs/guide/whats-new.md` ("Kobe is now Kaiju"): one paragraph for both changes.
- `docs/install.md` upgrade notes: KOBE-832 entry (no migration, rows read as stored, rolling
  upgrade).

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`: pass.
- Unit suites: server 4621 passed (8 skipped); web 4384; db 1113; protocol 1406; sandbox-agent
  1310 (200 skipped: real-Pi tests run in CI only).
- Server DB suite (`test:db`, whole): 324 files, 3772 passed. No schema or migration change; the
  db DB tests whose data changed (`git-repo-work.db.test.ts` and the probe suite, which uses the
  git probe fixture): 2 files, 931 passed.
- Eval image: `cli.py --validate-only` against pinned Orbit 1.0.3 in a local venv (see Tests);
  `test-image.sh` itself needs the built image (CI).
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs` (ok, 173 entries),
  `node --test scripts/rename/rename.test.mjs` (24 passed): ok.
