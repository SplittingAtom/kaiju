# KOBE-831: RN-18: stored value kobe migrated to kaiju; gallery agent renamed where unchanged

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-136-rename-18-values` in `../Kobe-g136`, stacked on
  `group-135-rename-17-users` (KOBE-830, PR #732) on #731 and #730
- **Spec:** `docs/specs/rename-kaiju.md` §11 answers A8 (rename stored values with a data
  migration) and A13 (gallery agent renamed where an install has not changed it); tooling
  `scripts/rename/README.md`

## What changed

- **Step patterns** (commit `chore: KOBE-831 RN-18 step patterns`): the two RN-18 groups'
  entries. **Applied** (`rename.mjs --apply --step RN-18`): 429 occurrences in 130 files, 2 paths
  (`gallery/agents/kaiju.ts`, `gallery/gallery-kaiju.db.test.ts`). Both RN-18 groups removed; the
  kept old values sit in one narrow permanent group (below). Two pre-upgrade inserts of
  `catalog-site-edit-upgrade.db.test.ts` went back to `'kobe'` (they write the old schema).
- **Where `kobe` was stored** (inventory groups, then a full column scan of a populated migrated
  database): the `registry_publisher` enum (`registry_skills`, `registry_versions`) and the
  CHECKs naming it; Kaiju-published provenance (`publisher`, and the scanner name
  `kobe-skill-scanner`, also in promoted and site versions); the frozen `tool_manifest` of
  published agent versions (Kaiju's tools had `source`/`scope` `kobe`: artifacts, shared files,
  memory, skill drafts, file edits; kept, see Decisions); the gallery agent's `gallery_key` and
  `slug`. Not stored:
  the theme preset (`kobe` was never a preset; the branding test that refuses it now uses
  `kaiju`, so no web theme check is needed), memory/file `source`/`scope` outside manifests (the
  policy engine derives descriptors from `BUILTIN_TOOLS` per call), the review finding `source`
  and the chat connector `kind` (computed; the OpenAPI doc said `kobe` for `kind`, fixed). The
  built-in connector name was KOBE-826's.
- **Migration `0262_kaiju_stored_values`** (hand-written; drizzle would drop and recreate the
  enum, which fails on existing rows). One transaction:
  1. drop the four registry CHECKs, `ALTER TYPE registry_publisher RENAME VALUE 'kobe' TO 'kaiju'`
     (rows keep their OIDs: no rewrite, no trigger), re-add the CHECKs with `kaiju`
     (`registry_versions_approval` compares as text, so it had to be re-added).
  2. provenance `publisher` and scanner name rewritten with `registry_versions_immutable` off for
     those two statements only.
  3. agent versions untouched (coordinator decision below). Every table touched is site-wide (no
     RLS): no team set, no FORCE lifted.
  4. gallery key `kobe` → `kaiju`, slug too unless another gallery agent holds `kaiju` (notice);
     two keys `kobe` and `kaiju` at once raise (no release ever seeded `kaiju`). New CHECK
     `site_agents_gallery_key_renamed` (`gallery_key <> 'kobe'`).
- **Code:** protocol `REGISTRY_PUBLISHERS`, `toolSourceSchema`, `toolScopeSchema`,
  `BUILTIN_TOOLS`; server seeds, detach/reset, catalog view, maintainers, catalog facts, policy
  prompt table; API field `kobe` → `kaiju` on a Site catalog skill (`KaijuState`), error codes
  `not_kaiju`, `kaiju_skill`, review finding source `kaiju`, scanner `kaiju-skill-scanner`; web
  reads them. `withSiteNames` became `withCurrentNames` and also maps tools' `source`/`scope` `kobe` →
  `kaiju`, permanently (every manifest reader goes through it: run tools, Dangerous mode, version
  records, eval publish).
  `@kaiju/db` `STARTUP_SEEDED_ROWS` compares the publisher as text with both spellings, so the
  CLI still backs up and restores databases of older releases (found by the restore test: `=
'kaiju'` is invalid enum input there).

## Decisions

- **Gallery agent rule (A13).** "Exactly the shipped definition" = not customized: every admin
  change (draft save, publish, rollback) runs `markCustomized` (KOBE-494), and the seed only ever
  writes the shipped definition of its generation. Generation 4 → 5 renames name and prompt
  (`You are Kaiju`; "read the Kaiju guide through the kaiju connector's docs tools"; the skill
  keeps its permanent name `kobe-guide`). Unchanged rows: the seed updates the draft and
  publishes v(n+1); v1..vn stay (threads pinned to them keep them). Customized rows:
  `skipped_customized`, generation recorded as 5, console says a newer repository version is
  available (Compare, Reset to repository). Forks are members' agents: their name, slug and
  `forkedFromAgentId/Version` are untouched (ids never change). The migration moves only the key
  and slug (identity, not admin-editable: "slugs can't change").
- **Slugs and references (ac-3), per type:** URLs (`/agents/[id]`, `/admin/.../agents/[id]`,
  `/v1/site/gallery/agents/:id`), schedules (`agent_id`), team default agent, thread agent
  pins, fork lineage and shared thread links all use the agent's id, which is kept, so nothing
  redirects. Stored mentions are `@file(...)` only (no agent mentions exist), so no alias is
  needed. The key is read only server-side (`KAIJU_GALLERY_KEY`) and moved by the migration.
  Where an old slug is still shown: audit rows (explained, below), Orbit eval rows (history), an
  agent export's file name (new exports say `kaiju.md`).
- **Frozen tool manifests are not rewritten (coordinator decision 2026-11-25).** A rewrite made
  every published-agent run on an old pod fail (`UnreadableVersionError`) for the minutes of each
  upgrade's roll; the value is internal (members and admins never see a tool's `source`/`scope`),
  so the owner's intent (members see Kaiju) holds without it. New code maps the old value
  whenever it reads a manifest, for good, since frozen versions keep it forever; old pods keep
  reading unchanged rows. Versions new pods publish say `kaiju`, which an old pod cannot read:
  agents published during the roll, and the gallery agent's generation-5 version (review L1,
  below).
- **Mixed rollout: where an old pod meets a rewritten value** (after the migration, before its
  replacement):
  - SQL naming the enum value `'kobe'` errors: its Kaiju skills seed at start (logged, retried by
    the next start), Site console detach/reset of a Kaiju skill (error), and run-start catalog
    facts for an agent naming a Kaiju skill the team has no install of yet (that run fails to
    start; teams normally have the Default installs). Acceptable: fail closed, minutes.
  - Gallery key lookup by `kobe` finds nothing: new chats on an old pod start with no agent, Make a
    skill from this / Workbench test chats / skill evals report the agent unavailable.
    Acceptable: fail closed.
  - Its gallery seed is refused by `site_agents_gallery_key_renamed` (logged, retirement
    postponed) instead of adding a second "Kobe". Intended.
  - JS comparisons with `"kobe"` stop recognizing Kaiju skills: the Site catalog view shows them
    as maintainer skills (cosmetic); detach refuses (`not_kobe`, fail closed).
  - Maintainers (review M1, fixed): the old maintainers guard would let a Site admin add a
    maintainer to a Kaiju skill, and that row would have outlived the roll, letting a non-admin
    deprecate/undeprecate Kaiju's versions and read their site-wide usage. Now refused by the
    database: trigger `registry_maintainers_not_kaiju` (insert or move of a maintainer row onto a
    Kaiju skill) and `registry_skills_kaiju_unmaintained` (a maintained skill becoming Kaiju's),
    both 23514 / `registry_maintainers_not_kaiju`, invoker rights, pinned search_path (as 0181);
    migration 0262 first deletes any such row, audited `skill.maintainer.removed` (system). In
    depth, deprecate/undeprecate (`isActiveMaintainer`) and the usage route never count a
    maintainer row on a Kaiju skill. Fail closed.
  - Member submission under a Kaiju name (review L2): the old `submissionRight` no longer sees
    the name as reserved, but the version insert is refused by `registry_versions_publisher_guard`
    (23503, a `maintainer` version on a `kaiju` skill). Acceptable: fail closed.
  - Gallery agent version from the new seed (review L1): the first new pod publishes generation 5
    with `kaiju` tool values; an old pod running the gallery agent's current version (new chat via
    team default, schedule, pinned thread on it) cannot parse it, so the run fails to start or
    every call is denied. Acceptable: fail closed, minutes; versions published before the upgrade
    keep working on old pods.
  - The old web shows Kaiju skills as "Team-published" and no detach panel until reloaded
    (cosmetic). No API aliases: the response field and error codes changed outright.
  - Runs on agent versions published before the upgrade: unaffected (manifests unchanged).
- **Audit history** untouched. The audit schema keeps `previousPublisher: "kobe"` readable
  (doc regenerated); the site and team audit views show `(before the rename; now kaiju)` next to
  `publisher`/`previousPublisher` `kobe` and a gallery agent's `slug`/`key` `kobe`
  (`renamedStoredValue` in `@kaiju/protocol`, by field, so a member's own agent named `kobe` is
  not relabelled).
- **No new team-setting exception**; `team-setters.test.ts` unchanged.

## One-release aliases (KOBE-754's removal list)

- None. Permanent (not one-release): the maintainer triggers, `withCurrentNames`' tool mapping (frozen versions keep the
  old value forever), `STARTUP_SEEDED_ROWS`'
  text comparison, the CHECK `site_agents_gallery_key_renamed`, the audit enum value and the
  audit views' explanation, the migration.

## Open

- None.

## Docs evaluation

Members and admins see the agent's name, the publisher in the catalog/API and audit rows:
`whats-new.md` (rename paragraph), operator `install.md` (upgrade note for 0262),
`audit-log.md` (regenerated), `skill-package.md`, `agents.md`, `file-editing.md`,
`admin/admin-from-a-conversation.md`, `reference/troubleshooting.md` (renamed by the step). In-sandbox
agents never see the publisher or manifest values; the "For agents" pages name the gallery agent
nowhere, so no change there. `/llms.txt` and `/docs/<slug>.md` are generated from these pages.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`, `db:check` (no changes after 0262): pass
  (rerun after the manifest decision).
- Unit: protocol 1406, db 1113, server 4618 (8 skipped), web 4384, cli 101, mcp-proxy 175,
  guide 33.
- New tests: db `kaiju-stored-values-upgrade.db.test.ts` (12, ac-1: two populated sites, enum
  labels and rows, the four CHECKs re-created and enforced, provenance, site/team manifests left
  as they were, gallery key/slug moved or kept, fork lineage, new CHECK, full column scan: old
  value only in `audit_log.target`, the versions' manifests and the fork's slug); server
  `policy/pre-rename-manifest.db.test.ts` (2: a run on a version frozen with `kobe` gets
  `create_artifact` allowed and its version reads with `kaiju`; control: an unparsable manifest
  denies); db upgrade test +3 (review M1: row removed and audited, insert/move refused for owner
  and app role, a maintained skill cannot become Kaiju's); server `skill-retirement.db.test.ts` +1
  (a stray maintainer row on a Kaiju skill cannot deprecate or read usage); server `gallery/gallery-kaiju-rename.db.test.ts` (3, ac-2 unchanged →
  Kaiju v2 with v1 kept, fork keeps name and `forkedFrom`, thread, team default and runnable list
  by id; customized → kept, update offered, Reset gives Kaiju; old key refused); cli
  `kaiju-stored-values-backup.db.test.ts` (2, ac-3 pre-rename backup restore then upgrade;
  refused on the new schema); server `manifest.test.ts` (+1), web `renamed-names.test.ts` (+1).
- Whole DB suites (pg_dump 17 from /usr/lib/postgresql/17/bin), after the coordinator's
  manifest decision: db 2212 passed (cross-team probe suite included), server 3770 passed, cli 55
  passed. Unit after it: db 1113, server 4618 (8 skipped).
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs`, rename self-test (24): ok.
- Found by the suites: `STARTUP_SEEDED_ROWS` (backup/restore of older releases) and the run-start
  catalog-facts query (replayed over an older schema in `skill-freeze-upgrade`) compare the
  publisher as text.
