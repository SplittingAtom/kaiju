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
  memory, skill drafts, file edits); the gallery agent's `gallery_key` and `slug`. Not stored:
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
  3. manifests (site and team versions) rewritten with the immutability triggers off and FORCE
     lifted on `team_agent_versions` only, no team set; a manifest the rewrite would push past
     64 KiB is left as is (readers map it). Orbit evals keep their copy (history).
  4. gallery key `kobe` → `kaiju`, slug too unless another gallery agent holds `kaiju` (notice);
     two keys `kobe` and `kaiju` at once raise (no release ever seeded `kaiju`). New CHECK
     `site_agents_gallery_key_renamed` (`gallery_key <> 'kobe'`).
- **Code:** protocol `REGISTRY_PUBLISHERS`, `toolSourceSchema`, `toolScopeSchema`,
  `BUILTIN_TOOLS`; server seeds, detach/reset, catalog view, maintainers, catalog facts, policy
  prompt table; API field `kobe` → `kaiju` on a Site catalog skill (`KaijuState`), error codes
  `not_kaiju`, `kaiju_skill`, review finding source `kaiju`, scanner `kaiju-skill-scanner`; web
  reads them. `withSiteNames` became `withCurrentNames` and also maps `kobe` tool values.
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
- **Mixed rollout (fail closed, minutes of the roll).** Old pods after the migration: SQL naming
  `'kobe'` for the enum errors (catalog facts, Kaiju skill seed, detach); rewritten manifests
  fail their strict parse, so runs on published agents and version views error
  (`UnreadableVersionError`); the default-agent lookup by key finds nothing (new chats start with
  no agent); their gallery seed hits the new CHECK and is logged as failed (retirement then
  postponed) instead of adding a second "Kobe". New pods read old-pod writes: manifests with
  `kobe` map for good. The old web shows Kaiju skills as "Team-published" and no detach panel
  until reloaded (cosmetic). No API aliases: the response field and error codes changed outright.
- **Audit history** untouched. The audit schema keeps `previousPublisher: "kobe"` readable
  (doc regenerated); the site and team audit views show `(before the rename; now kaiju)` next to
  `publisher`/`previousPublisher` `kobe` and a gallery agent's `slug`/`key` `kobe`
  (`renamedStoredValue` in `@kaiju/protocol`, by field, so a member's own agent named `kobe` is
  not relabelled).
- **No new team-setting exception**; `team-setters.test.ts` unchanged.

## One-release aliases (KOBE-754's removal list)

- None. Permanent (not one-release): `withCurrentNames`' tool mapping, `STARTUP_SEEDED_ROWS`'
  text comparison, the CHECK `site_agents_gallery_key_renamed`, the audit enum value and the
  audit views' explanation, the migration.

## Open

- During the roll, old pods fail every run on a published agent (all versions were rewritten).
  The alternative was read-time mapping only (no manifest rewrite, as KOBE-256 did); the owner
  asked for a data migration, so the rewrite stays and the window is documented in install.md.

## Docs evaluation

Members and admins see the agent's name, the publisher in the catalog/API and audit rows:
`whats-new.md` (rename paragraph), operator `install.md` (upgrade note for 0262),
`audit-log.md` (regenerated), `skill-package.md`, `agents.md`, `file-editing.md`,
`admin/admin-from-a-conversation.md`, `reference/troubleshooting.md` (renamed by the step). In-sandbox
agents never see the publisher or manifest values; the "For agents" pages name the gallery agent
nowhere, so no change there. `/llms.txt` and `/docs/<slug>.md` are generated from these pages.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`, `db:check` (no changes after 0262): pass.
- Unit: protocol 1406, db 1113, server 4618 (8 skipped), web 4384, cli 101, mcp-proxy 175,
  guide 33.
- New tests: db `kaiju-stored-values-upgrade.db.test.ts` (12, ac-1: two populated sites, enum
  labels and rows, the four CHECKs re-created and enforced, provenance, site/team manifests and
  the oversized one kept, triggers and FORCE back, gallery key/slug moved or kept, fork lineage,
  new CHECK, full column scan: old value only in `audit_log.target`, the fork's slug and the
  oversized manifest); server `gallery/gallery-kaiju-rename.db.test.ts` (3, ac-2 unchanged →
  Kaiju v2 with v1 kept, fork keeps name and `forkedFrom`, thread, team default and runnable list
  by id; customized → kept, update offered, Reset gives Kaiju; old key refused); cli
  `kaiju-stored-values-backup.db.test.ts` (2, ac-3 pre-rename backup restore then upgrade;
  refused on the new schema); server `manifest.test.ts` (+1), web `renamed-names.test.ts` (+1).
- Whole DB suites (pg_dump 17 from /usr/lib/postgresql/17/bin): db 2214 passed (cross-team probe
  suite included), server 3768 (3765 + `skill-freeze-upgrade` 3 after the catalog-facts fix;
  3 skipped), cli 55 passed.
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs`, rename self-test (24): ok.
- Found by the suites: `STARTUP_SEEDED_ROWS` (backup/restore of older releases) and the run-start
  catalog-facts query (replayed over an older schema in `skill-freeze-upgrade`) compare the
  publisher as text.
