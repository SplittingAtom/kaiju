# Rename: Kobe becomes Kaiju

Status: **approved** (Chris, 2026-11-21): every recommendation in §9 accepted. Hadron spec
`7423e332`; tickets RN-1..RN-10 filed (§10). Amended 2026-11-24 (KOBE-824) with the owner's answers to the
questions the inventory raised (§11), which add RN-11..RN-20. Work starts after the 2026-11-20 review tickets and the
Workspace git integration (`docs/specs/workspace-git.md`, KOBE-757..769) have merged (RN7, order
revised by Chris 2026-11-21). RN1, whether the name is clear to use, is Chris's check before the first step.
Request (Chris, 2026-11-21): rename the project from Kobe to Kaiju.

## 1. Summary

The product, the repository, the code and the packaging take the name Kaiju. Names that live
inside a running install and that no member or operator reads (Postgres settings, roles and
functions, persisted schema identifiers, signed strings) keep `kobe`, because changing them buys
nothing visible and each one needs a data migration with a failure mode. Stored names that members
or agents do see (the built-in connector, the sandbox folder and users, model ids, stored enum
values) are renamed with a migration, by the owner's answers of 2026-11-24 (§11). Operator-facing names
(Helm chart, images, environment variables, team namespaces) change, with the old environment
variable names accepted for one release. Ticket ids (`KOBE-123`) stay as they are.

The rename is done in one short freeze, after the 2026-11-20 review tickets have merged, as
scripted replacement in a fixed order with the full CI and e2e suite after each step, and ends with
a fresh install of the test cluster under the new name.

## 2. Today (measured on main `d3306b7e`, 2026-11-21)

`kobe` (any case) appears about 51,000 times in 4,970 of 5,821 tracked files, and in 811 file
paths. By kind:

| Kind                         | Count                        | Examples                                                                                               |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Ticket ids                   | about 19,000                 | `KOBE-437` in comments, ledgers, commit messages, test names                                           |
| Environment variables        | 554 distinct, about 5,600    | `KOBE_PUBLIC_URL`, `KOBE_APPROVAL_KEY`; 137 uses in chart templates                                    |
| Workspace packages           | 19 packages, about 2,900     | `@kobe/server`, `@kobe/db`, `@kobe/protocol`; binaries `kobe`, `kobe-migrate`, `kobe-db-wait`          |
| HTTP headers                 | about 490                    | `x-kobe-team`                                                                                          |
| Postgres settings            | about 340                    | `kobe.team_id` (every RLS policy), `kobe.audit`, `kobe.budget`, break-glass settings                   |
| Postgres roles and functions | about 350                    | `kobe_app`, `kobe_owner`, `kobe_reserve_budget`, `kobe_shipped_version`                                |
| Kubernetes names             | about 160 plus chart         | namespaces `kobe-team-<slug>`, `kobe-sandbox` (ServiceAccount, template, warm pool), `kobe-team-quota` |
| Images                       | 7                            | `ghcr.io/splittingatom/kobe-server`, `-web`, `-sandbox`, ...                                           |
| Persisted identifiers        | about 130                    | `kobe.dev/skill/v1` in skill packages, `kobe.approval.v1` in signed approvals                          |
| Browser storage and cookies  | about 75 keys                | `__Host-kobe-sso`, `kobe.lastTeamId`, `kobe-invitation`                                                |
| User-facing text             | 30 guide pages, web UI, mail | "Kobe" in the app shell, emails, `/docs`, `/llms.txt`, the built-in agent's prompts                    |

## 3. What changes and what stays

**Changes (Kaiju / `kaiju`):**

1. **Product name** everywhere a member, admin or in-sandbox agent reads it: web UI, emails, the
   guide, `/llms.txt`, agent and skill prompts, error messages, the admin MCP's tool descriptions,
   release notes from this release on, README, licence and notice files.
2. **Repository and tooling:** GitHub repo `SplittingAtom/kaiju` (GitHub redirects the old URL),
   `CLAUDE.md`, scripts, CI workflow names, the runner scale set.
3. **Code:** `@kaiju/*` packages, the `kaiju`, `kaiju-migrate` and `kaiju-db-wait` binaries, file
   and directory names, identifiers and types (`KobeEvent` becomes `KaijuEvent`), log `service`
   fields, telemetry attribute names.
4. **Packaging:** chart `charts/kaiju` (chart name `kaiju`), images
   `ghcr.io/splittingatom/kaiju-*`, sandbox image paths and the in-sandbox agent binary
   (`kaiju-sandbox-agent`).
5. **Operator configuration:** `KAIJU_*` environment variables. For one release every service also
   reads the `KOBE_*` name when the `KAIJU_*` one is unset and logs one warning naming the
   variables to rename; the release after removes the fallback.
6. **HTTP headers:** `x-kaiju-*`. Server and web ship together, so there is no mixed-version
   window for the browser; the sandbox agent and the proxies are in the same release. The server
   accepts `x-kobe-team` for one release for API clients and scripts.
7. **Kubernetes names for new installs:** team namespaces `kaiju-team-<slug>` and the
   `kaiju-sandbox` objects in them. An existing install keeps its prefix (see §5).
8. **Browser storage and cookies:** new keys. Members are signed out once by the upgrade and lose
   per-browser conveniences (last team, last thread, collapsed notices). SSO state cookies are
   short-lived and simply expire.
9. **Stored names members or agents see** (§11, added 2026-11-24): the built-in connector's id,
   tool names and settings keys; the `.kobe/` sandbox folder and the Pi names; `kobe-local/` model
   ids; stored enum values and the gallery agent where an install has not changed it; the sandbox
   Unix users. Each in its own step, with a migration wherever an install holds the old value (workspace volumes included). Names that
   files outside the install still carry (the skill manifest file name and field, the agent file
   section, MCP Apps names) are written new and read in both spellings. New workspace git
   branches use `kaiju/`. Built-in skills and versioned prompts get new versions with an eval.

**Stays `kobe` (internal, invisible, costly to change):**

1. **Ticket ids** `KOBE-n`, the Hadron project key and decision ids (D1–D32, TH1, WS-1, ...).
   They are history and cross-references; new tickets keep the `KOBE-` key (see RN2).
2. **Postgres settings, roles and functions:** `kobe.team_id` and the other `kobe.*` settings,
   `kobe_app`, `kobe_owner`, `kobe_*` functions, the `drizzle` bookkeeping. Applied migration files
   are never edited, so the old names stay in history whatever we do; renaming the live objects
   would touch every RLS policy in one migration for no visible gain.
3. **Signed and persisted identifiers:** `kobe.approval.v1` (the HMAC domain string; changing it
   voids pending approvals), `kobe.dev/skill/v1` and the other `kobe.dev/*` schema ids inside skill
   packages, agent files and exports that already exist outside the database. A later schema
   version may introduce `kaiju.dev/*` ids while still reading the old ones; not in this spec.
   (Corrected 2026-11-24: this item used to name "`kobe-models/*` gateway names stored in
   catalogs". No such stored value exists: `kobe-models` was the directory of the in-sandbox Pi
   extension, renamed `kaiju-models` with the code in RN-3, and no migration, schema or catalog
   row holds it. The stored model names are the Bifrost provider, key and customer names
   (`kobe-<provider>`, `kobe-site`, `kobe-install`), which stay with item 7 below, the model ids
   `kobe-local/...`, renamed in RN-15, and the Pi provider id `kobe`, renamed in RN-14.)
4. **S3 object keys.** Key layout has no product name in it today (checked in the upload,
   artifact, project, skill, workspace-sync and retention key builders); the bucket name and
   `s3.prefix` are the operator's.
5. **Backup format.** The manifest format id `kobe-backup/1` and the key-derivation labels
   `kobe-backup/v1/...` in `packages/cli`: changing them would make existing backups unreadable,
   and §5 restores one across the rename.
6. **Past release notes, gate documents, ledgers and the specs of earlier lanes**
   (`docs/specs/`, §11 A1) keep the name they were written under, with one line at the top of
   `docs/releases/` saying Kobe was renamed Kaiju in this release.
7. **Names held outside the database that existing installs read back:** git-mirror commit
   trailers, the Bifrost customer, provider, key and admin user names.
8. **Kubernetes label keys** `kobe.splittingatom.io/*` (§11 A9): selectors and network policies
   on objects in existing team namespaces use them. The chart's selector label value
   `app.kubernetes.io/name: kobe` and the database name `kobe` stay for the same reason (KOBE-750).
9. **An existing install's team namespace prefix** `kobe-team-` and the object names in those
   namespaces (§5, §11 A15, KOBE-751).

## 4. Order of work

One freeze: no other branch open, every worktree removed first. Each step is one PR through the
merge queue, scripted where possible (the script is committed under `scripts/rename/` so the result
can be reproduced and reviewed as "script plus exceptions" instead of a 5,000-file diff).

1. **Guard and inventory.** A test that lists every remaining `kobe` in tracked files against an
   allowlist file with a reason per pattern (§3 "stays"). It starts with everything allowed and
   each later step shrinks it; at the end it is the definition of done.
2. **User-facing text and assets** (no identifiers): UI strings, emails, guide, prompts, logo
   alt text, `/llms.txt`. Browser specs that assert on text move with it.
3. **Packages, binaries, paths, identifiers** (`@kobe/*`, file names, type names, log fields).
   Pure rename; lockfile, licence inventory and `THIRD_PARTY_LICENSES.md` regenerated.
4. **Environment variables with fallback** (`readEnv("KAIJU_X")` falling back to `KOBE_X` in each
   service's `config.ts`, one shared helper), chart templates and values, docs.
5. **Headers, cookies, storage keys, telemetry names.**
6. **Chart, images, Kubernetes names:** `charts/kaiju`, image names in publish and e2e workflows,
   `TEAM_NAMESPACE_PREFIX` becomes configuration (default `kaiju-team-`), in-namespace object names.
7. **Repository rename** on GitHub, then local remotes, CI secrets and the runner set, the deploy
   script and the coordinator's notes.
8. **Fresh test install** under the new name (§5) and the full browser suite.

## 5. Existing installs

The only existing install is the test cluster (`kobe-gate1`). The recommendation (RN4) is a fresh
install as release `kaiju` in a new namespace, restoring the database and bucket from a `kobe
backup` taken just before, which also exercises backup and restore across the rename. For any
install that upgrades in place instead:

- **Helm release name and namespace** are the operator's and do not change; resource names derive
  from the release name, so nothing is recreated by the chart rename itself. Upgrading means
  `helm upgrade <release> charts/kaiju` with values whose keys are unchanged. No values key contains the
  product name; three defaults do: image repositories (new images), `postgres.appRole: kobe_app`
  (stays, §3) and the skill registry's commit author (`Kobe Registry`, changes for new commits).
- **Team namespaces** keep `kobe-team-` on an existing install: the chart sets
  `sandbox.teamNamespacePrefix` from a lookup of what exists (default `kaiju-team-` on a fresh
  install), and the server refuses to start if namespaces with a different prefix exist than the
  one configured, with a message that says which value to set. Sandboxes, volumes and quotas are
  untouched. Moving an install to the new prefix is not offered (it would mean recreating every
  workspace volume from S3).
- **Environment variables** set through `extraEnv` or operator Secrets keep working for one
  release through the fallback.
- **Members** are signed out once and sign in again.
- **Database:** no migration renames Postgres settings, roles, functions or tables. The data
  migrations of §11 (RN-13, RN-14, RN-15, RN-18) rewrite stored values (connector id and tool
  names, model ids, enum values) and the workspace volumes' `.kobe/` folders; each is
  its own step, and the fresh install of RN-9 runs them on restored data.

## 6. Risks

- **Missed spots that only fail at runtime:** names built from strings (`"KOBE_" + key`), names in
  shell scripts and heredocs inside e2e, Dockerfile `ARG`s, Helm template helpers (`kobe.fullname`
  and 35 other defines), JSON schema `$id`s. The guard test in step 1 and a full e2e run per step
  are the control; the fresh install is the final check.
- **Over-replacement:** `KOBE-123` ticket ids, the allowlisted Postgres names, persisted schema
  ids. The replacement script works from explicit patterns per step, never a blanket `s/kobe/kaiju/`.
- **Half-renamed operator config:** both `KAIJU_X` and `KOBE_X` set with different values. The new
  name wins and the warning says so.
- **Open work at the time of the freeze:** every branch not merged before step 3 has to be
  re-created; the freeze is scheduled when the lanes are empty.
- **Third parties:** the GitHub App for CI runners, ghcr package visibility (new packages start
  private), Dependabot configuration paths, any bookmark to `/docs` anchors.

## 7. Out of scope

- A new logo, colours or domain. The logo text changes; artwork is a separate request.
- Renaming Postgres objects, persisted schema ids or the approval signature domain (§3).
- Renaming the Kubernetes label keys `kobe.splittingatom.io/*` (§11 A9).
- Renaming Hadron's project or the existing tickets.
- Moving an existing install's team namespaces to the new prefix.

## 8. Acceptance

1. No member, admin, operator or in-sandbox agent sees "Kobe" anywhere in the product, the guide
   or operator documentation for this release, apart from the one-line rename note and past
   release notes.
2. The guard test passes with an allowlist that contains only the §3 "stays" patterns.
3. A fresh install from `charts/kaiju` with `kaiju-*` images passes the full e2e and browser suite.
4. An install configured only with `KOBE_*` variables starts, works and logs the rename warning.
5. Backup from the old-name test install restores into the new-name install with no data loss.
6. `pnpm verify`, the DB suites, the licence check and image builds are green; the repository is
   reachable under its new name and the old URL redirects.

## 9. Decisions (Chris, 2026-11-21: all recommendations accepted)

| Id  | Question                                                                                                                                                                 | Decision                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| RN1 | Is the name clear to use? "Kaiju" is a common word and is used by other software projects; trademark, the GitHub name, ghcr namespace and any domain are yours to check. | Check before step 1; nothing else in this spec depends on the answer except whether to start.                                    |
| RN2 | Do new tickets keep the `KOBE-` key?                                                                                                                                     | Yes. One key across the project's history; a second key splits every search.                                                     |
| RN3 | Do Postgres settings, roles, functions and persisted schema ids stay `kobe` (§3)?                                                                                        | Yes. Invisible, and each change is a risky data migration.                                                                       |
| RN4 | Test cluster: fresh install under the new name with a restore, or upgrade in place?                                                                                      | Fresh install with restore.                                                                                                      |
| RN5 | How long are `KOBE_*` variables and `x-kobe-team` accepted?                                                                                                              | One release, then removed.                                                                                                       |
| RN6 | Spelling in running text: "Kaiju" always, lower case `kaiju` in code and commands?                                                                                       | Yes.                                                                                                                             |
| RN7 | When? The rename conflicts with every open branch.                                                                                                                       | After the 2026-11-20 review tickets and, by Chris's revision of 2026-11-21, after the Workspace git integration (KOBE-757..769). |
| RN8 | Does the generic-Kubernetes work (if you want it) go before or after?                                                                                                    | After: it adds chart values and docs that would otherwise be renamed twice.                                                      |

## 10. Tickets

| Id               | Ticket                                                                                                  | Size |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| RN-1 (KOBE-745)  | Guard test and allowlist of remaining `kobe`; `scripts/rename/` with the per-step pattern lists         | S    |
| RN-2 (KOBE-746)  | User-facing text: web UI, emails, guide, prompts, `/llms.txt`, README, notices; browser specs           | M    |
| RN-3 (KOBE-747)  | Packages, binaries, file paths, identifiers, log fields; lockfile and licence inventory                 | L    |
| RN-4 (KOBE-748)  | Environment variables `KAIJU_*` with one-release fallback and warning; chart templates; operator docs   | M    |
| RN-5 (KOBE-749)  | Headers, cookies, browser storage keys, telemetry attribute names                                       | M    |
| RN-6 (KOBE-750)  | Chart `charts/kaiju`, image names, publish and e2e workflows                                            | M    |
| RN-7 (KOBE-751)  | Team namespace prefix as configuration: default for new installs, detected for existing, start-up check | M    |
| RN-8 (KOBE-752)  | Repository rename, remotes, CI runner set and secrets, deploy script, `CLAUDE.md`                       | S    |
| RN-9 (KOBE-753)  | Fresh test install under the new name with restore from backup; full browser suite; rename release note | M    |
| RN-10 (KOBE-754) | Next release: remove the `KOBE_*` and `x-kobe-team` fallbacks                                           | S    |
| RN-11 (KOBE-824) | Record the owner's answers of 2026-11-24 (§11) in this spec; give each held allowlist group its step    | S    |
| RN-12 (KOBE-825) | Skill manifest file name and `compatibility` field: write the new names, accept both                    |      |
| RN-13 (KOBE-826) | Built-in connector id, tool names, routes and settings keys, with a data migration                      |      |
| RN-14 (KOBE-827) | `.kobe/` sandbox folder and Pi names, with a migration that includes workspace volumes                  |      |
| RN-15 (KOBE-828) | `kobe-local/` model ids, with a migration                                                               |      |
| RN-16 (KOBE-829) | MCP Apps names: new names, the old ones accepted                                                        |      |
| RN-17 (KOBE-830) | Sandbox Unix users renamed with the same numeric ids; `/home/kobe` kept as a symlink                    |      |
| RN-18 (KOBE-831) | Stored enum values and rows, with a data migration; the gallery agent renamed where unchanged           |      |
| RN-19 (KOBE-832) | `kaiju/` prefix for new workspace git branches; agent file section written `kaiju:`, both read          |      |
| RN-20 (KOBE-833) | New versions of the built-in skills and versioned prompts under the new name, with an eval              |      |

Order of work (`STEPS` in `scripts/rename/lib.mjs`, enforced by the guard and the script): RN-2..RN-8,
then RN-12..RN-20, then RN-9, so that the fresh install with a restore checks every migration.
RN-10 follows in the next release. RN-10 and RN-11 own no allowlist groups.

## 11. Owner answers 2026-11-24

Chris answered the questions of the inventory (KOBE-745, "Open questions") on 2026-11-24, one at a
time. The answers are final. The KOBE-745 list numbers its items 1–15 differently from this table
from item 12 on: its item 12 was this spec's `kobe-models/*` claim (corrected in §3, stays 3), and
its allowlist group Q12 (built-in skills and prompts) is answer A12 here. Answers map by subject;
the allowlist groups carried the same Qn as the answers.

| Id  | Subject                                                                            | Answer                                                                        | Step             |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| A1  | Specs of earlier lanes (`docs/specs/`)                                             | Keep their old names, like the gate documents                                 | permanent        |
| A2  | Skill package manifest file name `kobe.skill.yaml` and its `compatibility.kobe`    | Accept both names                                                             | RN-12 (KOBE-825) |
| A3  | Built-in connector id `kobe`, its tool names `mcp__kobe__*`, routes, settings keys | Rename, with a data migration                                                 | RN-13 (KOBE-826) |
| A4  | The `.kobe/` sandbox folder, Pi entry types and the Pi provider id `kobe`          | Rename, with a migration that includes the workspace volumes                  | RN-14 (KOBE-827) |
| A5  | Model ids `kobe-local/...`                                                         | Rename, with a migration                                                      | RN-15 (KOBE-828) |
| A6  | MCP Apps names shared with app servers (`io.kobe/*`, `kobe/notifications/*`)       | New names; the old ones still accepted                                        | RN-16 (KOBE-829) |
| A7  | Sandbox Unix users `kobe`, `kobe-agent`, `kobe-pi-<n>`, `kobe-tool-<n>`            | Rename, keeping the same numeric ids, with a `/home/kobe` symlink             | RN-17 (KOBE-830) |
| A8  | Value `kobe` in stored enums and rows (publisher, source, scope, preset, slug)     | Rename, with a data migration                                                 | RN-18 (KOBE-831) |
| A9  | Kubernetes label keys `kobe.splittingatom.io/*`                                    | Keep                                                                          | permanent        |
| A10 | Workspace git branch prefix `kobe/<member>/...`                                    | `kaiju/` for new branches                                                     | RN-19 (KOBE-832) |
| A11 | Agent file (orbit) export section `kobe:`                                          | Write `kaiju:`, read both                                                     | RN-19 (KOBE-832) |
| A12 | Built-in skill packages and versioned model prompts (pinned bytes)                 | New versions under the new name, with an eval                                 | RN-20 (KOBE-833) |
| A13 | The gallery agent "Kobe"                                                           | Rename where an install has not changed it                                    | RN-18 (KOBE-831) |
| A14 | Operator-visible telemetry names (`kobe.run`, `kobe.tool.*`, syslog SD-ID)         | Rename, with a release note                                                   | done in KOBE-749 |
| A15 | In-namespace object names                                                          | Same rule as the namespace prefix: new installs `kaiju-*`, existing ones keep | done in KOBE-751 |

A2 and A11 both touch files that live outside an install (skill packages, agent files): the new
name is written and both names are read, so packages and agent files exported before the rename
keep working. Every migration step keeps the old names its fallbacks read in a permanent allowlist
group with its reason, removed in a later release like the RN-10 fallbacks.
