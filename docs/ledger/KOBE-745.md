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
  `kobe.sandbox-bootstrap`, `kobe.*.v<n>` HMAC/HKDF labels, the trace-span key label. The review
  agreed (spec §1).
- **Binary files** are scanned too (latin1); none of the 3 tracked binaries contains the name.
  **Generated files** get their own groups (lockfile → RN-3 via `pnpm install`; product name in
  `THIRD_PARTY_LICENSES.md`/`NOTICE` → RN-2 and image paths → RN-6 via `pnpm licenses:update`).

## Review round 1 (merge after fixes): what changed

- **Engine:** kept groups (permanent, then provisional) protect paths too: their content entries
  also match file paths (C1 applied migrations, C2 `kobe.skill.yaml`). Questions are a
  `provisional` step; `guard.mjs --final` fails while any non-permanent group remains (M6).
- **rename.mjs `--apply`:** all or nothing (M1): checks first, then writes; on any failure it
  resets to HEAD. Refuses: an earlier step's groups still present (M2), a dirty tree, rewriting a
  binary, non-UTF-8 file or symlink (M3), a target that exists or collides case-insensitively, and
  a path rename whose references another step (or a left-out group) owns (H4; Markdown and
  generated files are only reported). Symlinks are read with `lstat`; a missing tracked file
  gives a clear error.
- **Now permanent:** `kobe-guide` and the built-in connector URLs (C3, C5: CHECK constraints),
  `kobeShippedVersion` and other `kobe*` schema properties (C4: column mapping), every
  advisory-lock name and derived-hash label (H1; RN-5 patterns now match only inside quotes, with
  a trailing boundary), audit action names (H2), git-mirror trailers (H8), Bifrost customers
  `kobe-site`/`kobe-install` (H9), more ticket-id forms `KOBE-${n}`, `KOBE-[1-4]`, `KOBE-xx` (H7).
- **Ownership fixes:** `x-kobe-team` is RN-5's only (H3); objects inside team namespaces
  (`kobe-sandbox`, quotas, NetworkPolicies, LimitRange, RoleBinding) are RN-7 hand work with the
  configured prefix, and RN-7's patterns skip `charts/**` and `sandbox/constants.ts`, so the
  gVisor admission policy is never renamed mechanically (H5, H6); `kobe-sandbox-token` is an RN-5
  header with accept-both hand work (M5); the Pi extensions, image sources and Python packages
  move with RN-6 (H4); bare `KOBE` in code is an RN-3 identifier. RN-4's header names the
  `KOBE_TEST_DATABASE_URL` trap (M4).
- **Self-test:** 19 tests, one per finding (path protection, binary, order, atomic rollback,
  target collision, reference conflict) plus owners of review sample lines on the real allowlist
  and step files (M7).

## Each step applied in isolation (throwaway worktree, removed afterwards)

`--apply --step RN-n` in order on `093ffd1ce`; after each: the step's allowlist groups deleted,
`pnpm build` and `pnpm typecheck`. RN-3 also ran `pnpm install` (lockfile: the step's hand work).

| Step | Applied (occ. / files / paths) | build | typecheck | Still hand work (owned, unchanged)                            |
| ---- | ------------------------------ | ----- | --------- | ------------------------------------------------------------- |
| RN-2 | 3,433 / 1,142 / 0              | ok    | ok        | 222: docs `Triage:` tail, generated NOTICE/THIRD_PARTY        |
| RN-3 | 12,911 / 2,751 / 79            | ok    | ok        | 2,036: test-fixture and app-code `Triage:` tails, lockfile    |
| RN-4 | 3,775 / 476 / 0                | ok    | ok        | the KOBE\_\* fallback helper and warning (runtime, not built) |
| RN-5 | 752 / 320 / 0                  | ok    | ok        | accept `x-kobe-team` and `kobe-sandbox-token` for one release |
| RN-6 | 2,689 / 506 / 187              | ok    | ok        | 730: e2e/chart `Triage:` tail, licence inventories            |
| RN-7 | 115 / 48 / 0                   | ok    | ok        | 98: prefix configuration, in-namespace object names           |
| RN-8 | 102 / 19 / 1                   | ok    | ok        | the GitHub rename, runner set, variables                      |
| RN-9 | 5 / 5 / 0                      | ok    | ok        | the fresh install itself                                      |

Not checked per step: unit/e2e tests, image builds, a real install. One finding of the first run
was fixed before the final run (bare `KOBE` as RN-2 broke RN-2's typecheck; RN-5's unquoted
`kobe.agent` matched a test variable). After RN-3, one provisional entry went stale (the lookbehind
on `kobeName`); it now accepts both names.

## Review round 2: paired values

Rule (now in `splitValues()`, `guard.mjs --pairs`, and a self-test that fails on any split except
listed distinct meanings): a value two sides must agree on has every occurrence in one group.

- R2-1: every line comparing or minting `iss` with `kobe-server` is kept (site egress check).
- R2-2/H9: Bifrost customer names `kobe-site`/`kobe-install` and provider names
  (`kobe-${providerId}`, `kobe-vllm`) kept wherever written, quoted or not.
- R2-3: `MANAGED_BY` and the server-side-apply `FIELD_MANAGER` join the RN-7 hand work.
- Other pairs found and fixed: LISTEN/NOTIFY channels (`kobe_egress`, `kobe_models`, ...) kept;
  label-key constant kept; sandbox Unix users (`kobe`, `kobe-agent`, `kobe-pi-<n>`,
  `kobe-tool-<n>`) held together (Q7); chart tests belong with the chart; the connector and
  catalog API segments `/kobe` kept with their web client (Q3); the branch prefix where code
  builds it (Q10); paired groups for fake-model markers, Service/Secret names, the mirror's
  commit author, e-mail addresses, test hosts; built-in skill packages and versioned prompt text
  provisional (Q12: pinned bytes); RN-2 prose skips e-mail addresses; the file-reference entry
  no longer matches S3 keys.
- Isolation run (throwaway worktree on `b74bbfe0e`, removed): RN-2..RN-6 applied in order, each
  builds and typechecks; then unit suites: `@kaiju/session-token` 24/24, `@kaiju/model-gateway`
  260/260, `@kaiju/server` 4,565 passed, 8 skipped, 0 failed. (Earlier runs failed 14 server
  tests; each was a list bug fixed above. One run refused RN-3 on a reference conflict, as it
  should.)

## Totals (this branch, `node scripts/rename/guard.mjs --report`)

61,770 occurrences in 5,948 files; 139 entries in 57 groups, 276 lines.

| Owner                                     | Occurrences | Files |
| ----------------------------------------- | ----------: | ----: |
| permanent                                 |      33,523 | 5,560 |
| provisional (Q1–Q12 below)                |       1,617 |   497 |
| RN-2 user-facing text                     |       3,597 | 1,132 |
| RN-3 packages, identifiers, paths         |      14,700 | 2,975 |
| RN-4 environment variables                |       3,775 |   476 |
| RN-5 headers, cookies, storage, telemetry |         747 |   319 |
| RN-6 chart, images, release-namespace     |       3,479 |   572 |
| RN-7 namespace prefix, in-namespace names |         225 |    68 |
| RN-8 repository, CI, CLAUDE.md            |         102 |    20 |
| RN-9 test install names                   |           5 |     5 |

## Open questions (for Chris)

Held as `provisional` (no step touches them) until answered (Q12 added in round 2: built-in skill packages and versioned prompt text; renaming them needs new versions); group names carry the number.
Recommendation in brackets. Per the review, Q3, Q4, Q7 (and maybe Q5, Q8) stay visible to agents
or members, against spec §8.1: keep them and amend §8.1, or add read-both logic, before RN-9.

1. **Q1 Specs of earlier lanes** `docs/specs/*.md` (391 / 18). [keep as design records]
2. **Q2 Skill manifest file name** `kobe.skill.yaml` (240 / 94, any case). [keep]
3. **Q3 Built-in connector** id `kobe`, `mcp__kobe__*`, `/connectors/kobe`, `kobe_mcp.*` settings, deny codes (176 / 52). [keep]
4. **Q4 Workspace and Pi session names** `.kobe/`, `kobe.branch` etc., Pi provider id `kobe` (328 / 165). [keep]
5. **Q5 Model ids** `kobe-local/...` (77 / 31). [keep]
6. **Q6 MCP Apps names shared with Catalyst**: `io.kobe/item-kind`, `kobe/notifications/drag-*`, host name (31 / 14). [keep, or add new names accepting the old]
7. **Q7 Sandbox Unix users and home** (`kobe`, `kobe-agent`, `kobe-pi-<n>`, `kobe-tool-<n>`, `/home/kobe`). [keep]
8. **Q8 Value `kobe` in persisted enums** (publisher, source, scope, theme preset, agent slug; 130 / 63). [keep]
9. **Q9 Kubernetes label keys** `kobe.splittingatom.io/*` (40 / 24). [keep, like the namespace prefix]
10. **Q10 Git branch prefix** `kobe/<member>/...` (14 / 11). [new branches `kaiju/`]
11. **Q11 Agent file (orbit) export section** `kobe:` (4 / 4). [keep]
12. **Spec's `kobe-models/*` gateway names**: no such stored value; the stored one is provider id `kobe` (Q4).
13. **Built-in gallery agent "Kobe"**: existing installs keep the name in their rows without a data update. Rename existing rows?
14. **Operator-visible telemetry names** (RN-5): `kobe.run`, `kobe.tool.*`, syslog SD-ID `kobe@<PEN>`. Rename with a release note, or keep?
15. **In-namespace object names** (RN-7): configured or detected per install (planned), or keep `kobe-*` everywhere?

## Doc evaluation

No user-guide change: this step adds developer tooling and a CI check only; nothing a member,
admin or in-sandbox agent sees or can do changes. `scripts/rename/README.md` documents the tooling.

## Evidence

- `node scripts/rename/guard.mjs`: ok, 61,770 allowed occurrences, 139 entries, ~1.8 s.
- `node --test scripts/rename/rename.test.mjs`: 21 tests pass.
- Per-step isolation run: table above.
