# KOBE-833: RN-20: built-in skills and versioned prompts under the new name, with an eval

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-138-rename-20-skills` in `../Kobe-g138`, stacked on
  `group-137-rename-19-branches` (KOBE-832, PR #734) on #733
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A12 (new versions with the new name, with an
  eval); tooling `scripts/rename/README.md`

## What changed

- **Step patterns** (commit `chore: KOBE-833 RN-20 step patterns`): `steps/RN-20.txt` (built-in
  package contents and paths, `build.ts`). Before the apply, the permanent `kobe-guide` entry that
  shadowed the packages (earlier reviews' finding) was narrowed, and extractor prompts v1/v2 moved
  to a new permanent group (pinned history). **Applied:** 58 occurrences in 16 files, 10 paths
  (`*/kaiju.skill.yaml`, `kaiju-guide/`, `skill-creator/scripts/kaiju_rules.py` and its imports).
- **Built-in skills (ac-1).** All eight get a new minor version: 1.1.0, skill-creator 1.3.0
  (manifest `kaiju.skill.yaml`, changelog, text). `kobe-guide` → `kaiju-guide`, its text naming
  `mcp__kaiju__docs_index` and `kaiju-builtin` (KOBE-826's open item). The schema id
  `kobe.dev/skill/v1` stays (spec §3). Six skills' runtime bytes are unchanged (only the manifest
  differs), so their runtime hash repeats; the seed and the database key versions by package hash
  and semver, which is allowed. Hashes appended to `kaiju-packages.test.ts` (append only;
  `kobe-guide` 1.0.0 kept as history) and scans to `builtin-scans.test.ts` (verdicts unchanged).
- **Names:** `KAIJU_SKILL_NAMES` (shipped set) lists `kaiju-guide`; new
  `PRE_RENAME_KAIJU_SKILL_NAMES` (`kobe-guide` → `kaiju-guide`) and `KAIJU_RESERVED_SKILL_NAMES`
  (`@kaiju/protocol`); `isKaijuSkillName` and the registry's reserved names cover both. DB:
  `KAIJU_PRE_RENAME_SKILL_NAMES`, `KAIJU_SKILL_NAMES_ADDED_LATER` adds `kaiju-guide`.
- **Migration `0263_kaiju_guide_skill`** (CHECK generated, middle hand-written):
  1. Kaiju's `kobe-guide` row renamed `kaiju-guide` in place (same id), unless another catalog
     skill already holds `kaiju-guide` (then it keeps `kobe-guide`, notice; the seed then skips
     Kaiju's new version, as KOBE-620 did).
  2. CHECK `registry_skills_kobe_names` (name kept, like `by_kobe` columns): both names Kaiju's;
     a non-Kaiju row may keep either name it held.
  3. Trigger `registry_skills_pre_rename_name` (BEFORE INSERT OR UPDATE OF name, invoker rights,
     pinned search_path, 23514): no Kaiju row gets `kobe-guide`. Found while checking the roll: a
     previous-release pod ships `kobe-guide` 1.0.0 and, finding no such row, would have created a
     second guide skill and Default-installed it in every team.
- **References (`services/server/src/skills/renamed-skills.ts`):** `currentSkillNames` maps an
  agent's `kobe-guide` to `kaiju-guide` at run start (`loadSkillFacts`) unless a catalog skill
  holds `kobe-guide`; `namesResolvingTo` makes the catalog page's "agents using it" and revoke
  notices count agents that list the old name. Kaiju names are never frozen, so publish/freeze
  needed nothing.
- **Gallery agent:** generation 6 lists `kaiju-guide` and its prompt line names it (KOBE-831's
  generation 5 had kept `kobe-guide`). Normal generation rule: unchanged rows get a new version,
  customized ones are offered the update.
- **Extractor prompt `memory-extractor-v3`** (`memory/learn/prompt/v3/`, current): a byte copy of
  v2 with "Kobe" → "Kaiju" in the system message's first two lines; rules, reply format and
  instructions identical (diff is those two lines). Pinned hash `4918a281…`. The transcript
  message's speaker line in shared `build.ts` says Kaiju too (all versions; only v3 is sent by
  this release). v1/v2 and their fixtures untouched.

## Decisions

- **Rename in place, not a second skill.** A new `kaiju-guide` row beside `kobe-guide` would need
  a hand-made carry-over of every install, pin, opt-out and block, and the Default sync would
  re-add it to teams that had opted out. Renaming the row carries all of that by id (ac-1 "by
  migration"); 1.0.0 stays in the skill's history; 1.1.0 is above it so the seed publishes.
- **Explicit pins:** an install a team admin pinned to 1.0.0 stays on 1.0.0 (old text, wrong tool
  name in prose only: the model gets the real tool list) and shows Update available, as for any
  pin. Rewriting an admin's explicit choice was rejected. Its bundle is mounted under the catalog
  name `kaiju-guide` while its SKILL.md says `kobe-guide`; the sandbox agent does not compare them.
  Within-major and latest installs move by themselves (resolved per run).
- **Agent references are mapped, not rewritten.** Published versions are immutable and drafts are
  members' text; the read-time mapping is permanent (like KOBE-831's `withCurrentNames`).
- **Minimal prompt change** (ac-2, no model access here): only the product name in v3 and the
  speaker line. The gallery agent's prompt change is one skill name.
- **Fixtures:** v3's fixtures are v2's recorded replies, carried over: they replay through the
  parser and screen, which a name change does not touch. New recordings for v3 come from the
  coordinator's model run below (its JSON keeps every raw reply).

## Mixed rollout (old pods during `helm upgrade`)

Old pods find no `kobe-guide` catalog skill: a run there naming it gets `not_installed`; their seed
fails for `kobe-guide` only (trigger), logged and retried until replaced; the other seven skills
are `unchanged` for them (bytes held). Fail closed, minutes. Old pods' extractor still records
`memory-extractor-v2`.

## Eval (ac-2)

**Offline, run here:** fixture replay of v3 (pinned hash, 13 fixtures, adversarial leave no
Workspace candidate) and the extractor harness dry run over the ~100 cases with v3:
v3 fixture replay plus `build.test.ts`: 47 passed (v1/v2 fixtures unchanged and green).
`KAIJU_EXTRACTOR_DRY_RUN=1 e2e/memory-eval.sh extractor` (out dir `~/tmp`, gate page untouched):
`memory-extractor-v3` PASS, precision 1.000, recall 1.000, scope 1.000, kind 1.000, 0 adversarial
Workspace/Site candidates, adversarial pass 100% (27/27), schema-valid 99.0%: identical to the
v1 dry-run row in `docs/gates/gate-7b.md`. This checks harness, cases and screen with v3, not a
model. No prompt snapshot exists beyond the pinned hashes.

**Runbook for the coordinator (model runs, before and after, same day, same model).** No secrets
in the repo; the key stays in the shell. Use the Site's learning model on the test install
(gate-7b: `glm-5.3-flash`, reasoning, unstructured, catalog max output 131072).

```bash
# 1. Extractor before (v2) and after (v3), from two checkouts.
git worktree add ../kaiju-eval-before group-137-rename-19-branches   # v2 is current there
for dir in ../kaiju-eval-before ../Kobe-g138; do (cd "$dir" && pnpm install --frozen-lockfile &&
  KAIJU_EXTRACTOR_URL=https://<provider>/v1 KAIJU_EVAL_MODEL=glm-5.3-flash \
  KAIJU_EXTRACTOR_LABEL=glm-5.3-flash KAIJU_EXTRACTOR_REASONING=1 \
  KAIJU_EXTRACTOR_MAX_OUTPUT_TOKENS=131072 KAIJU_EXTRACTOR_API_KEY_FILE=<key file> \
  KAIJU_EVAL_OUT_DIR=$HOME/tmp/kobe-833-eval KAIJU_EXTRACTOR_GATE_DOC=none \
  e2e/memory-eval.sh extractor); done
# Writes extractor-memory-extractor-v2-glm-5.3-flash.{json,md} and ...-v3-... side by side.
# To file v3 in the gate page: copy the v3 pair into docs/gates/gate-7b/, or rerun v3 without
# KAIJU_EVAL_OUT_DIR and KAIJU_EXTRACTOR_GATE_DOC so the harness writes the pair and its row.
git worktree remove ../kaiju-eval-before
```

Compare: precision, recall, scope accuracy (Gate B thresholds 0.8 / 0.6 / 0.8 must hold),
adversarial Workspace/Site candidates (must be 0), adversarial pass rate, schema-valid rate, kind
and operation accuracy. No regression = thresholds hold and no metric drops beyond run-to-run
noise (baseline v2 on 2026-11-16: 0.985 / 0.956 / 0.985, kind 0.815, adversarial 0); if one
drops, rerun both once before deciding (each JSON keeps the raw replies, so a screen question can
be re-scored with `KAIJU_EXTRACTOR_REPLAY=<file>.json`).

```bash
# 2. Gallery agent (prompt generation 6, skill kaiju-guide): Orbit safety eval before and after
# the deploy, in the same team, as a Site admin (cookie or token from the browser):
curl -s -X POST "$URL/v1/site/gallery/agents/<id>/eval" -H "Cookie: $C" \
  -H 'Content-Type: application/json' -d '{"teamId":"<team>"}'
curl -s "$URL/v1/site/gallery/agents/<id>/scores" -H "Cookie: $C"   # when finished
```

Compare the score and its per-scenario results between the gallery agent's generation-5/4 version
(before) and generation 6 (after). Then ask the agent "How do I add a member to my team?" in a new
chat: the run should load `kaiju-guide` 1.1.0 and call `mcp__kaiju__docs_index`/`docs_page`.

**Model results:** not run (no model access here); pending the coordinator before merge.

## Allowlist

- RN-20 group removed. The line-90 permanent group (`** /\bkobe-guide\b/`, which shadowed RN-13
  and RN-20) is replaced by a file-scoped group naming the reserved-name lists, the mapping, the
  pinned table, the tests that build the old state and the docs; the migrations are owned by the
  applied-migrations group. New permanent group for extractor prompts v1/v2.
- `rename.test.mjs` samples updated (old package paths now unowned; the old name in an agent file
  unowned; the kept names permanent).
- `guard.mjs --final`: only `[RN-9] Test install names` not done (0 uncovered, 0 stale):
  `scripts/rename/allowlist.txt:272: not done: [RN-9] Test install names, replaced by the fresh
install under the new name`.

## One-release aliases (KOBE-754's list)

- None. Permanent: the mapping of `kobe-guide`, its reservation, the trigger, the migration.

## Docs evaluation

Members, admins and agents see the skill's name, its versions and the guide pages that name it:
`docs/guide/agents/skills.md`, `for-agents/reading-the-docs.md`,
`for-agents/working-in-a-sandbox.md` (skill name), `whats-new.md` (paragraph: new versions,
rename in place, pins, old agent lists keep working, new extractor prompt), operator `install.md`
(upgrade note for 0263, trigger, rollout), `docs/skill-package.md` (built-ins' manifest). `/llms.txt`
and `/docs/<slug>.md` are generated from these. The skill's own text is what agents read.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`: pass. `db:check`: no schema change after 0263.
- Unit: protocol 1406, db 1113, server 4658 (8 skipped), web 4384, guide 33. sandbox-agent not
  touched (skill-creator's Python imports checked by hand: `import kaiju_rules, validate,
package, init_skill`).
- DB suites (whole): db 2218 passed (new `kaiju-guide-skill-upgrade.db.test.ts`, 3); server 3776,
  first run 6 failures, all hard-coded versions or generation (`variant()` replaced only
  `version: 1.0.0`, site-edit semvers above 1.0.0, gallery generation 5), fixed and the five files
  rerun: 32 passed (incl. new `kaiju-guide-rename.db.test.ts`, 4, and `kaiju-guide-seed`); cli 55.
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `guard.mjs`: ok; self-test 24 passed.
