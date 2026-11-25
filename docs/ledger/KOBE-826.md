# KOBE-826: RN-13: built-in connector id kaiju and tools mcp__kaiju__*, with a data migration

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-131-rename-13-connector` in `../Kobe-g131`, stacked on
  `group-130-rename-12-manifest` (KOBE-825, PR #727) on `group-129-rename-11-spec` (PR #726)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A3 (rename, with a data migration); tooling
  `scripts/rename/README.md`

## What changed

- **Narrowed** (commit `chore: KOBE-826 narrow RN-13`): step patterns = the RN-13 group;
  `kobe_omitted` (a marker stored in append-only run events, not a connector name) and the
  advisory-lock key `kobe_mcp.limit:` (old and new pods must lock the same key) moved to
  permanent groups.
- **Scripted** (`rename.mjs --apply --step RN-13`): 438 occurrences in 98 files, 2 paths
  (`kaiju-builtin-{connector,upgrade}.db.test.ts`). Some incidental test strings the group owned
  were renamed with it (`realms/kaiju`, `postgres://…/kaiju` in config tests, `/tmp/kaiju-git-*`
  scratch dirs, which live in the server's emptyDir only).
- **Migration `0260_kaiju_builtin_connector`** (hand-written: drizzle's CHECK statements around a
  data step that must run between the drops and the adds; `db:rebase` keeps it). In one transaction:
  - built-in rows (ids kept): `builtin` `kobe` → `kaiju`; name `kobe` → `kaiju` (else
    `kaiju-builtin`, else unchanged with a notice) and `kobe-git` → `kaiju-git` (else
    `kaiju-git-builtin`); marker URLs → `http://kaiju-server.internal/internal/v1/mcp/{kaiju,git}`;
    CHECKs `connectors_builtin` and `connectors_builtin_url` updated.
  - where a name changed, `mcp__<old seg>__` → `mcp__<new seg>__` in: `site_tool_rules`,
    `tool_rules` (team rules and remembered approvals), `team_connectors.enabled_tools`,
    `team_agents` / `site_agents` frontmatter (`tools.allow`, `tools.deny`, connector names) and
    `team_agent_versions` / `site_agent_versions` (frontmatter and frozen `tools_allow`,
    `tools_deny`, `connectors`). Prefix match only (`mcp__kobe__*` yes, `mcp__ko*` no). A
    registered connector really named `kobe` (site whose built-in was `kobe-builtin`) keeps its
    tools' names.
  - settings: site `kobe_mcp.{mode,reads_per_minute,writes_per_hour}` → `kaiju_mcp.*`; each
    team's `teams.settings` `kobe_mcp.admin` → `kaiju_mcp.admin`.
  - pending approvals of an old name: `expires_at` = now (see Decisions).
  - `site_settings` `kaiju_mcp.renamed` = `{"segments": {"kobe": "kaiju", "kobe_git":
"kaiju_git"}}` (only what was renamed): the marker history readers use.
  - Checked and not needed: `thread_connectors_off`, `team_connectors` rows and
    `runs.mcp_connector_ids` reference the fixed ids. Grepped every text/jsonb/array column of a
    migrated database; history kept on purpose: `audit_log`, `run_events`, `thread_entries`,
    decided approvals, `run_skipped_actions`, `thread_app_results`, `orbit_evals`. Agent prompts
    (free text) are not rewritten.
- **Server:** seeds and readers use `kaiju` / `kaiju_mcp.*`; deny codes `kaiju_admin_*` (the
  `kobe_admin_*` ones are historical codes in `@kaiju/protocol` `HISTORICAL_POLICY_NAMES`, and
  `isKaijuAdminAsk` accepts both so old approvals stay out of remember / Approve all); audit setting
  values `kaiju_mcp_mode` etc. (old values still parse); engine `renamed` dep; expiry message for
  renamed approvals; `kaijuBuiltinSegments` for shared-thread redaction; audit pages return
  `renamedToolSegments` (OpenAPI documented).
- **Web:** new routes and fields; `renamed-names.ts` + site and team audit views show
  `mcp__kobe__x (before the rename; now mcp__kaiju__x)`, and the same for the old setting names
  and deny codes; `renamedToolSegments` is an opaque key in `camelizeKeys`.

## Decisions

- **Agent versions are rewritten, not read through a shim.** The owner asked for it; their
  immutability trigger is disabled for this one statement inside the migration transaction
  (owner role) and re-enabled; nothing else in a version changes. `contentKey` is computed, not
  stored, so drafts and versions stay comparable.
- **Pending approvals:** signed over the tool name (D29), never re-signed. The migration makes
  them due; `decide` refuses them at once (`approval_expired`, 409) and the regular expiry (broker
  timer or sweep) ends them with events, audit and a `run.failed` whose message names the rename
  (`renamedApprovalMessage`). No new cause value (no CHECK change). Allowed but unconsumed approvals
  of an old name are left: their token (10 min) is checked against the new name and fails closed.
- **Remembered approvals / scopes:** `tool_rules` rows are not signed (glob, remembered input and
  scope only), so they are migrated in place; no dual match needed.
- **Mixed rollout:** the migration runs before new pods. Old server pods then find no `builtin =
'kobe'` row: their runs get no Kaiju/git tools and calls by any name are denied (unknown tool);
  their seed hits the new CHECK and logs an error (seed failures never stop a server). Fail
  closed, for the minutes of a rolling update: accepted. Receivers accept both for one release:
  the server serves `/internal/v1/mcp/kobe/*`, `/v1/team/connectors/kobe` (old `kobe` response
  key), `/kobe/compare|reset`, and the old site-settings fields (read and written); the MCP proxy
  keeps **sending** the old internal path this release (a new proxy may meet an old server). The
  new web calls the new routes (an old server answers 404 to them for those minutes).
- **Resumed threads / running sandboxes:** refused, not mapped (mapping would carry the old name
  into approvals and the signed binding). The MCP list is part of Pi's launch key, so the next run
  restarts Pi with `mcp__kaiju__*`; a model that calls `mcp__kobe__x` from history gets `unknown_tool`
  "… was renamed to mcp__kaiju__x in an upgrade; call mcp__kaiju__x instead." A run in flight
  across the upgrade loses the built-in tools until its next turn.
- **No new team-setting exception.** FORCE RLS lifted per table inside the migration (as
  0235/0258); no `kobe.team_id` is set. `team-setters.test.ts` unchanged and green.
- **Allowlist line-90 group:** its URL entry was removed (the URL moved); `kobe-guide` stays.

## One-release aliases (add to KOBE-754's removal list)

- `PRE_RENAME_SEGMENT` (`@kaiju/protocol`): server internal route `/internal/v1/mcp/kobe/*`, MCP
  proxy `builtinPath` sending it, `/v1/team/connectors/kobe` (+ `kobe` key), catalog skill
  `/kobe/compare` and `/kobe/reset`; their `undocumented-allowlist.ts` entries, route-inventory lines.
- Site settings fields `kobeMcpMode`, `kobeReadsPerMinute`, `kobeWritesPerHour` (in and out).
- Allowlist group "Pre-rename paths and fields of the built-in connector…" and the install note.
- Not one-release (permanent): historical deny codes, audit setting names, the
  `kaiju_mcp.renamed` marker and its readers, the migration.

## Open

- The built-in `kobe-guide` skill text still says `mcp__kobe__docs_index` (pinned bytes): RN-20
  (KOBE-833) publishes it under the new name. The model sees the real tool list meanwhile.
- A registered connector carrying the new marker URL would block the migration's new CHECK
  (unrealistic: `.internal` URLs are refused at registration).

## Docs evaluation

Members, admins and agents see the connector name, tool names, API fields and audit rows, so the
guide changes here (ac-4): `whats-new.md` (rename paragraph), `for-agents/working-in-a-sandbox.md`
(The kaiju connector, "Old names"), `for-agents/reading-the-docs.md`, `for-agents/concepts.md`,
`connectors-and-apps.md`, `admin/admin-from-a-conversation.md`, `admin/git-organizations.md`, `for-agents/working-with-git.md`,
`admin/team-admin.md` and `admin/site-admin.md` (audit views), `reference/troubleshooting.md`;
operator docs `install.md` (upgrade note), `audit-log.md` (historical names, regenerated table),
`rate-limits.md`. `/llms.txt` and `/docs/<slug>.md` are generated from these pages.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`, `db:check` (no changes): pass.
- Unit: protocol 1392, db 1113, server 4594 (8 skipped), mcp-proxy 175, cli 101, guide 33,
  web 4319, sandbox-agent 1294 (196 skipped, real Pi in CI), egress-proxy 182, model-gateway 267.
- New DB tests: `packages/db/src/kaiju-builtin-rename-upgrade.db.test.ts` (13: two populated
  sites, every rewritten table, FORCE and triggers back, fresh install), server
  `kaiju-mcp/kaiju-rename-upgrade.db.test.ts` (4, ac-2 through the policy engine), cli
  `kaiju-builtin-rename-backup.db.test.ts` (2, ac-3 restore then upgrade; refused on new schema).
- Whole DB suites: db 2193 passed, server 3755 passed, cli 51 passed.
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs`, rename self-test (24): ok.
