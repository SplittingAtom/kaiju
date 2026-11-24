# KOBE-745: RN-1: guard test and allowlist of remaining `kobe`; scripts/rename with per-step pattern lists

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-117-rename-1-guard` in `../Kobe-g117` (stacked on `group-116-deps-wave`)
- **Depends on:** spec `docs/specs/rename-kaiju.md`; RN1 (name clear to use) is Chris's check before RN-2 (ac-3)

## Plan

Renames nothing. Adds `scripts/rename/` (guard, allowlist, replacement script, one pattern list per
step, self-test, README) and wires the guard and self-test into CI's static job and `pnpm verify`.

## Decisions

- **Guard home: a root script** (`node scripts/rename/guard.mjs`), next to `check-site-wording.mjs`,
  not a package test like `packages/db/src/team-setters.test.ts`. Turbo keys a package's `test`
  cache on that package's files only and CI restores main's cache, so a repo-wide guard inside a
  package replays a cached pass when only files elsewhere changed. (The same holds for the existing
  team-setters and run-usage-retention guards in `@kobe/db`; not changed here.) Run time ~1.5 s.
- **Ownership:** first matching entry, top to bottom; permanent groups first; an entry owning
  nothing fails (the list only shrinks). Entries are regexes matched per line (or per path), so a
  file that mixes permanent and renamed uses is split by pattern, not passed whole; only history
  (ledgers, gates, releases, reviews, applied migrations, the rename spec and tooling) is
  allowed per path.
- **The script follows the allowlist:** a step changes an occurrence only if its own pattern
  matches, the allowlist owns it in a group whose header the step file repeats, and no permanent
  entry covers it. The allowlist is the one arbiter of which step owns what; generated files and
  `Triage:` tails are owned but left out of the step files, so dry runs show them as hand work.
- **Pattern lists live in `.txt` files.** The team-setters and run-usage-retention guards scan
  source extensions; naming the settings in data files keeps both guards green without touching
  their allowlists. The scripts themselves never spell a setting.
- **Read as signed strings (spec §1), so permanent:** session-token audiences
  (`kobe.sandbox-wire`, `kobe.mcp-proxy`, ...), issuer `kobe-server`, the projected-token audience
  `kobe.sandbox-bootstrap`, `kobe.*.v<n>` HMAC/HKDF labels, the trace-span key label. Advisory-lock
  names of Postgres (`kobe.legal_hold`, `kobe.audit.pii_sweep`) sit with the settings. Say if any
  of these should move to RN-5.
- **Binary files** are scanned too (latin1); none of the 3 tracked binaries contains the name.
  **Generated files** get their own groups (lockfile → RN-3 via `pnpm install`; product name in
  `THIRD_PARTY_LICENSES.md`/`NOTICE` → RN-2 and image paths → RN-6 via `pnpm licenses:update`).

## Totals (this branch, `node scripts/rename/guard.mjs --report`)

61,555 occurrences in 5,948 files (contents and paths, this branch's new files included); 106 entries in 48 groups, 221 lines.

| Owner                                     | Occurrences | Files |
| ----------------------------------------- | ----------: | ----: |
| permanent (spec §3 "stays")               |      32,963 | 5,552 |
| permanent, provisional (Q1–Q13 below)     |       1,518 |   477 |
| RN-2 user-facing text                     |       3,716 | 1,160 |
| RN-3 packages, identifiers, paths         |      15,884 | 3,107 |
| RN-4 environment variables                |       3,775 |   476 |
| RN-5 headers, cookies, storage, telemetry |         692 |   278 |
| RN-6 chart, images, Kubernetes names      |       2,627 |   415 |
| RN-7 team namespace prefix                |         272 |   168 |
| RN-8 repository, CI, CLAUDE.md            |         103 |    20 |
| RN-9 test install names                   |           5 |     5 |

Permanent split: ticket ids 23,046; history docs 4,243; applied migrations 4,307; rename spec and
tooling 356; Postgres settings 136, objects 274; signed/persisted ids 524; migration markers 28.

## Dry run (`node scripts/rename/rename.mjs --summary`; writes nothing)

| Step | Would change (occurrences / files / paths) | Left for hand edits (owned, no pattern yet)                     |
| ---- | ------------------------------------------ | --------------------------------------------------------------- |
| RN-2 | 3,508 / 1,154 / 0                          | 208: docs `Triage:` tail, generated NOTICE/THIRD_PARTY text     |
| RN-3 | 13,551 / 2,832 / 204                       | 2,121: test-fixture and app-code `Triage:` tails, lockfile      |
| RN-4 | 3,775 / 476 / 0                            | 0 (fallback helper is hand work)                                |
| RN-5 | 692 / 278 / 0                              | 0                                                               |
| RN-6 | 2,084 / 393 / 80                           | 463: e2e/chart `Triage:` tail (`psql_kobe` 130, release `kobe`) |
| RN-7 | 272 / 168 / 0                              | 0 (prefix configuration is hand work)                           |
| RN-8 | 102 / 19 / 1                               | 0                                                               |
| RN-9 | 5 / 5 / 0                                  | 0                                                               |

## Open questions (for Chris)

The spec is silent on these classes. Each is held as provisional `permanent` (no step touches it)
until answered; the group name in `allowlist.txt` carries the number. My recommendation in brackets.

1. **Q1 Specs of earlier lanes** `docs/specs/*.md` (395 in 18 files, e.g. `kobe-admin-mcp.md`): keep as design records like gate docs, or rename? [keep]
2. **Q2 Skill manifest file name** `kobe.skill.yaml` (227 / 86): lives inside packages that exist outside the DB, like `kobe.dev/skill/v1`. [keep; read both if renamed later]
3. **Q3 Built-in connector** id `kobe`, tool names `mcp__kobe__*`, route `/connectors/kobe`, site setting keys `kobe_mcp.*`, deny codes `kobe_admin_write` (174 / 52): stored in rows, policy rules and thread history. [keep]
4. **Q4 Workspace and Pi session names**: folder `.kobe/`, Pi entry types `kobe.branch` etc., Pi provider id `kobe` (328 / 165). [keep]
5. **Q5 Audit field names** `kobeCommitId` (13 / 7), stored in audit rows. [keep]
6. **Q6 Model ids** `kobe-local/...` (77 / 31), stored in catalogs. [keep]
7. **Q7 MCP Apps names shared with external app servers** (Catalyst): `_meta` key `io.kobe/item-kind`, bridge methods `kobe/notifications/drag-*`, host name `kobe` (31 / 16). [keep, or add `kaiju` names while accepting the old]
8. **Q8 Sandbox home** `/home/kobe` (28 / 12): Pi sessions and files hold absolute paths. [keep]
9. **Q9 Value `kobe` in persisted enums**: registry publisher, memory/file `source`/`scope`, theme preset, built-in agent slug, gallery key (133 / 63; e.g. `publisher: "kobe"`). [keep]
10. **Q10 Rate-limit row keys and lock names** `kobe:<purpose>:`, `kobe.skill-eval.reaper` (54 / 25): old and new pods share them in an upgrade. [keep]
11. **Q11 Kubernetes label keys** `kobe.splittingatom.io/*` (40 / 24) on objects in existing team namespaces. [keep, like the namespace prefix]
12. **Q12 Git branch prefix** `kobe/<member>/...` pushed to members' repositories (14 / 11). [new branches `kaiju/`; old ones stay]
13. **Q13 Agent file (orbit) export section** `kobe:` (4 / 4). [keep]
14. **Spec's `kobe-models/*` gateway names** (§3 stays 3): no such persisted value exists; `kobe-models` is the Pi extension's name (given to RN-3/RN-6) and the stored provider id is `kobe` (Q4). Confirm the spec meant the provider id.
15. **Built-in gallery agent "Kobe"** (`services/server/src/gallery/agents/kobe.ts`: `name: Kobe`, "You are Kobe"): RN-2 renames the seed, but existing installs keep the name in their rows without a data update (§5 says no migration). Rename existing rows?
16. **Operator-visible telemetry names** given to RN-5: span/attribute names `kobe.run`, `kobe.tool.*` (114) and the syslog SD-ID `kobe@<PEN>` (6 / 3). Operators' SIEM and trace queries match them. Rename in RN-5 (as planned) with a release note, or keep?

## Doc evaluation

No user-guide change: this step adds developer tooling and a CI check only; nothing a member,
admin or in-sandbox agent sees or can do changes. `scripts/rename/README.md` documents the tooling.

## Evidence

- `node scripts/rename/guard.mjs`: ok, 61,555 allowed occurrences, 106 entries, ~1.5 s.
- `node --test scripts/rename/rename.test.mjs`: 11 tests pass (case handling, globs, parse errors,
  unowned and stale findings, dry run writes nothing, one step changes only its own names,
  permanent `kobe.dev/`, `KOBE-123`, `kobe_reserve_budget` and the team setting untouched,
  `x-kobe-team` waits for RN-5, idempotent second run, dirty tree refused).
