# Delete a Workspace

Status: **approved** (Chris, 2026-11-22): the twelve questions of the proposal are answered (§10) and
applied throughout. Origin: KOBE-742. Chris said on 2026-11-20 that deleting a Workspace is wanted.
Tickets DW-1..DW-12 (§11) are to be filed; nothing is built. Measured on `6b354027`.

**Start condition:** no ticket of this spec starts before the rename to Kaiju
(`docs/specs/rename-kaiju.md`, KOBE-745..754) has merged. The order is fixed (Q12): the
2026-11-20 review tickets, then Workspace git (`docs/specs/workspace-git.md`, KOBE-757..769), then
the rename, then this. When the work starts, the deletion plan registry (§5.7) must cover every
table added by Workspace git, and the names in this spec (Kobe, `kobe-team-<slug>`, `x-kobe-*`) are
read as the names after the rename.

Origin: storage review finding STO-11 (low): "Workspaces (teams) cannot be deleted, so a
decommissioned team's data is kept everywhere"; proposed fix "a Site-admin Delete workspace behind
legal-hold checks that purges threads through the existing batches, deletes the `teams/<id>/`
prefix through the retention queue, destroys the namespace, then deletes the team row. Size L."
This spec keeps that outline but does **not** delete the team row (§4, D3).

## Terms

- **Workspace**: the tenant. One row in `teams`; `team_id` on every team table; one Kubernetes
  namespace `kobe-team-<slug>`; one Bifrost team. "Team" in code and in the database means the same
  thing (`docs/specs/workspaces.md` §1: "a Workspace is one team, the same row, namespace").
- **Scratchspace**: one member's own files volume in one Workspace (what the code still calls the
  sandbox "workspace": `sandboxes`, `workspace_files`, `workspace_sync`, the PVC). Deleting a
  Workspace deletes every Scratchspace in it; deleting a Scratchspace alone is offboarding and is
  not this spec.
- **Site**: the whole deployment. Site admins and the Site owner act from the Site console.
- **Tombstone**: what is left of a deleted Workspace on purpose (§5.14).
- **Approval rule**: the Site setting that says who may request and approve a deletion (§5.2).

## 1. Summary

A person allowed by the Site's **approval rule** asks for a Workspace to be deleted and a person
allowed by the same rule approves. By default (rule 1) a Site admin requests and a second Site admin
approves (one admin on a single-admin Site approves their own request, flagged, as for
break-glass); the Site owner can switch the Site to rule 2, where only the Site owner requests and
approves. The Workspace then is **pending deletion** for a fixed grace period of 30 days: nobody
can run anything in it, members can still read it and export their own data, and any Site admin can
cancel. When the period ends, and only if no legal hold touches the Workspace, a resumable server
job deletes everything the Workspace owns in bounded batches under team RLS, deletes its
object-storage prefixes, tears down its namespace and gateway state, checks that nothing is left
and leaves a tombstone: the `teams` row with its id, name, dates and totals, which keeps the audit
log, legal-hold and break-glass records and Site proposals readable. The slug is released. The
audit log is kept. Backups and versioned bucket copies keep the data until they age out; Kobe says
so in the dialog and the guide. The last non-Registry Workspace of a Site cannot be deleted.

## 2. What a Workspace owns today

### 2.1 Team tables (96)

From the tenancy registry (`packages/db/src/tenancy/*.ts`, combined in `packages/db/src/tenancy.ts`;
the CI catalog check fails on any unclassified table, so this list is complete for the schema at
`6b354027`). Each has `team_id NOT NULL`, FORCE RLS and, in most cases, a foreign key to `teams`
with `ON DELETE CASCADE` (76 cascading keys across `packages/db/src/schema/`; the non-cascading keys
are all on site-wide tables, §2.2).

| Area                                                                                   | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threads, entries, events (`conversations.ts`)                                          | `threads`, `thread_entries`, `runs`, `run_events`, `events`, `answer_feedback`, `answer_feedback_history`, `thread_app_results`, `thread_folders`, `thread_branch_labels`, `thread_file_links`                                                                                                                                                                                                                                                                                                                                                                                          |
| Runs, usage, models, budgets (`models.ts`)                                             | `team_models`, `model_gateway_keys` (sealed per-member virtual keys), `run_usage` (append-only), `team_budgets`, `model_spend_daily` (trigger-kept), `run_tokens`, `budget_reservations`                                                                                                                                                                                                                                                                                                                                                                                                |
| Policy, approvals, egress (`policy.ts`)                                                | `tool_rules`, `team_egress` (sealed injected headers), `approvals`, `egress_requests`, `egress_request_notifications`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Projects and commits, files, artifacts, file memory (`workspace.ts`)                   | `projects`, `project_members`, `project_files`, `project_commits`, `project_tree_entries`, `project_checkouts`, `artifacts`, `artifact_versions`, `files`, `team_storage_quotas`, `memory_docs`, `memory_doc_versions`, `team_memory_settings`                                                                                                                                                                                                                                                                                                                                          |
| Scratchspaces and sandboxes (`sandbox.ts`)                                             | `sandboxes`, `sandbox_connections`, `sandbox_commands`, `sandbox_run_leases`, `sandbox_eval_connections`, `workspace_sync`, `workspace_files`, `workspace_blobs`, `workspace_file_hold_history`, `workspace_moves`, `workspace_sync_conflicts`                                                                                                                                                                                                                                                                                                                                          |
| Semantic memory incl. embeddings (`memory.ts`; pgvector columns on the version tables) | `semantic_memory_items`, `semantic_memory_item_versions`, `run_memory_items`, `run_portable_memory_items`, `run_site_memory_items`, `memory_stewards`, `memory_reminders`, `memory_learning_passes`, `memory_candidates`, `memory_dismissals`, `memory_learning_watermarks`, `memory_proposals`, `memory_project_suggestions`                                                                                                                                                                                                                                                           |
| Agents, versions, skills, drafts, evals, catalog use (`agents.ts`)                     | `team_agents`, `team_agent_versions` (immutable), `team_agent_suspensions`, `team_agent_roster`, `agent_transfers`, `team_skills`, `team_skill_versions` (immutable), `team_skill_reviews`, `team_skill_settings`, `team_skill_installs`, `team_skill_optouts`, `team_skill_blocks`, `team_skill_requests`, `member_skill_enablements`, `skill_drafts`, `skill_draft_files`, `skill_draft_history`, `skill_draft_file_history`, `skill_eval_runs`, `skill_eval_results`, `skill_promotion_requests`, `team_eval_settings`, `orbit_evals`, `agent_eval_cases`, `agent_eval_case_history` |
| Schedules and notifications (`schedules.ts`)                                           | `schedules`, `notifications`, `notification_emails`, `run_skipped_actions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Connectors (`connectors.ts`)                                                           | `team_connectors`, `connector_grants` (members' sealed keys and tokens), `thread_connectors_off`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Membership and retention (`identity.ts`)                                               | `team_members`, `team_invitations`, `team_retention`, `retention_blob_deletions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Workspace git (KOBE-757..769, `docs/specs/workspace-git.md`) merges before this work starts and adds
connection tables with sealed host credentials. They are not in the count above; the deletion plan's
coverage test (§5.7) forces them in.

There are **no per-Workspace API or MCP tokens**: the admin MCP acts as the signed-in person
(`docs/specs/kobe-admin-mcp.md`), run-bound gateway tokens are `run_tokens` (above), and SCIM
tokens are per identity provider, site-wide.

### 2.2 Site-wide rows that reference a Workspace

From `teamReferencing` in the tenancy files and the foreign keys to `teams.id`:

| Table                                     | Reference                                           | Rule today                                                                                                      |
| ----------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `audit_log`                               | `team_id`, no FK                                    | Append-only for every role; triggers refuse DELETE (`docs/audit-log.md`, "What is guaranteed")                  |
| `legal_holds`                             | FK, NO ACTION (`schema/legal-holds.ts:38`)          | "Never deleted"; transitions by `legal_holds_guard`                                                             |
| `break_glass_grants`                      | FK, NO ACTION (`schema/break-glass.ts:57`)          | "Never deleted"; `break_glass_grants_guard`                                                                     |
| `site_memory_proposals.from_team_id`      | FK, RESTRICT (`schema/site-memory-proposals.ts:71`) | KOBE-665: a Workspace that ever proposed cannot be deleted until proposals are handled (`docs/guide/memory.md`) |
| `session_active_teams`, `user_last_teams` | FK, NO ACTION (`schema/session-active-teams.ts`)    | Pointers only                                                                                                   |
| `sso_access_mappings`                     | FK, CASCADE (`schema/sso.ts`)                       | Site configuration naming a team role                                                                           |
| `site_skill_settings.registry_team_id`    | FK, SET NULL (`schema/registry.ts:421`)             | The Registry team; `teams.registry = true` marks it                                                             |
| `budget_alerts` (+ `budget_alert_emails`) | `team_id`, no FK                                    | Insert-only for the app role                                                                                    |
| `registry_versions.source`                | JSON naming the originating team, no FK             | Immutable identity; catalog bytes live under catalog keys, not the team's                                       |
| `skill_default_syncs.after_team_id`       | cursor only, no FK                                  | Walks all teams                                                                                                 |

Not team-owned and untouched by a Workspace deletion: users and their sign-in data, site roles and
grants, portable memories and Site memories, personal skills and personal agents (a personal agent
on the Workspace roster loses only its `team_agent_roster` row), Site agents, the catalog, site
connectors and their site keys, providers and the model catalog, `site_model_spend_daily` (site
totals; its trigger only adds, so past spend stays counted).

Threads are shared only inside their Workspace (sharing, copies and "Add to project" never cross
the wall), so no other Workspace holds a copy that would need a decision.

### 2.3 Object storage

All Workspace objects live under two prefixes inside the configured `s3.prefix`:

- `<prefix>teams/<team_id>/`: `threads/<id>/{entries,uploads,artifacts,apps,shared}/…`
  (`retention/blobs.ts` `threadKey`), `projects/<id>/{files,staging}/…` and project blobs,
  `users/<user>/workspace/<sha256>` and `users/<user>/{shared,uploads}/…` (Scratchspace blobs,
  `workspace-sync/keys.ts`), `memory/<doc>/<version>` (file memory), `skill-evals/<uuid>/…`.
- `<prefix>skills/teams/<team_id>/<sha256>/<attempt>` (team skill bundles, `skills/storage.ts`).

Catalog copies of promoted skills are stored under catalog keys (`skills/kobe-seed.ts`
`ensureObject`/`catalogObjectKey`), so deleting the team prefixes does not break the catalog. The
`site: true` columns of `BLOB_REF_COLUMNS` (`packages/db/src/blob-refs.ts`) are still checked
before any delete (§5.8).

### 2.4 Kubernetes

Per Workspace, all inside namespace `kobe-team-<slug>` (`services/server/src/sandbox/manifests.ts`):
the Namespace, a RoleBinding to the manager ClusterRole, three NetworkPolicies (sandbox, eval, skill
scan), a ResourceQuota, a LimitRange, a ServiceAccount, an image-pull Secret copy, the
SandboxTemplate, SandboxWarmPool, SandboxClaims and their pods, and one PVC per Scratchspace plus
the warm pool's (StorageClass `reclaimPolicy: Delete`, `charts/kobe/templates/sandbox-storageclass.yaml`).
The server's ClusterRole may `get, list, create, patch` namespaces but **not delete** them
(`charts/kobe/templates/sandbox-rbac.yaml:78-80`); the admission policies already allow and confine
a namespace DELETE to `kobe-team-*` (`sandbox-admission.yaml`).

### 2.5 Gateway and proxies

Bifrost holds one Bifrost team (`kobe-team-<team_id>`) and one virtual key per member
(`kobe-vk-<team>-<user>`), derived from Kobe's rows; anything not desired is removed by the sync
(`services/server/src/models/desired.ts`, `sync.ts`). Its persistent store (1 GiB PVC) is a cache.
The egress proxy and mcp-proxy read team rows from Postgres with NOTIFY hints; they hold no
durable per-Workspace state.

### 2.6 Outside Kobe's reach

`kobe backup` dumps (whole Site), the bucket's noncurrent versions (30 days recommended,
`docs/backup-restore.md` "Object storage"), audit events already forwarded to a SIEM, CNPG or
managed-Postgres backups, server and proxy logs (ids, no content), and anything upstream: connector
services, git hosts, model providers.

## 3. What exists to reuse

| Need                     | Existing code                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purge threads in batches | `retention/purge.ts` `purgeBatchInTx`/`purgeThreads`: short team transactions, legal-hold lock first, held threads skipped, KH001 means held, `SKIP LOCKED`, blob keys queued in `retention_blob_deletions`, audit last. Add a selection `{ kind: "team" }` (every thread, Trash included). |
| Purge other areas        | `retention/memory.ts`, `semantic-memory.ts`, `memory-learning.ts`, `skill-drafts.ts`, `skill-evals.ts`, `eval-cases.ts`, `project-history.ts`, `workspace-hold-history.ts`, `feedback-history.ts`                                                                                           |
| Delete objects           | `retention/blobs.ts` (queue drain, legal-hold lock, reference checks), `retention/bounded-delete.ts` (`deleteBounded`, 30 s timeout, abort and recover), `retention/orphans.ts` (paged `ObjectStore.list` by prefix, per-team caps)                                                         |
| Per-member teardown      | `offboarding/` (`destroy.ts` sandbox and claim, `purge.ts` volume and Scratchspace copies, `reinstate.ts`); `connectors/grant-departures.ts` (KOBE-696: grants deleted, no upstream revoke)                                                                                                 |
| Namespace convergence    | `sandbox/team-reconcile.ts` (skips namespaces being deleted; converges every labelled one)                                                                                                                                                                                                  |
| Exports                  | Member export `retention/export.ts` (own threads, files, memories, projects they may read, feedback); Workspace memory export (`memory.items.exported`); offboarding export (`offboarding/export.ts`)                                                                                       |
| Legal holds              | `lockLegalHolds`, `isUnderLegalHold`, `legalHoldsForTeam` (`packages/db/src/legal-hold/index.ts`); Site-wide hold; portable-hold snapshots (`legal-hold/portable-hold.ts`); KH001 delete guards on purged tables                                                                            |
| Background jobs          | `startup/jobs.ts` `ServerJob` (named, `start`/`once`, leader locks such as `RETENTION_LOCK`, `OFFBOARDING_SWEEP_LOCK`); `startup-seeds.db.test.ts` runs every job once on a fresh Site                                                                                                      |
| Visit every team         | `scanTeams()` (`packages/db/src/team-scan.ts`), an accepted exception; 18 callers, plus 55 `.from(teams)` reads in `services/` and `packages/`                                                                                                                                              |
| Two-person approval      | `legal_holds_guard` / `break_glass_grants_guard` triggers; approval rule and flagged single-admin self-approval (D1)                                                                                                                                                                        |
| Whole-Site copy          | `kobe backup` / `kobe restore` (`packages/cli`): whole Site only, no per-Workspace restore                                                                                                                                                                                                  |

There is no Workspace deactivation or archive state today (`teams` has `id, slug, name, settings,
registry, created_at`).

## 4. What blocks a simple "DELETE FROM teams"

1. The app role has no DELETE on `teams` (`tenancy/identity.ts`: "foreign-key cascades bypass RLS
   and would wipe another team's rows"). One cascade would also be one unbounded transaction over
   96 tables.
2. `legal_holds` and `break_glass_grants` reference the team with NO ACTION and are "never
   deleted"; `site_memory_proposals` is RESTRICT on purpose (KOBE-665). Deleting the row means
   deleting governance records.
3. Immutable tables refuse a direct DELETE and let only a cascade through (`pg_trigger_depth() > 1`):
   `run_usage` (`0045_run_usage_rls.sql`), `model_spend_daily` (`kobe_spend_guard`, `0047`),
   `team_agent_versions` (`0020`), `team_skill_versions` (`0051`), current semantic-memory versions
   (`0217`, `0222`). Their comments name "deleting the team" as the intended path.
4. `audit_log` refuses DELETE for every role; `budget_alerts` is insert-only.
5. The server cannot delete namespaces (RBAC, §2.4).
6. 18 `scanTeams` callers and about 55 other team reads walk every team: retention, offboarding,
   default syncs, rescans, the scheduler, budget monitor, model sync, egress relays, notifications.
   Without a state they keep acting on a Workspace that is going away (re-installing skills,
   waking sandboxes, re-creating Bifrost keys).

Hence the design: keep the `teams` row as the tombstone (solves 2 and 4), delete team rows table
by table under RLS (solves 1), let the immutable guards also pass while their team is in state
`deleting` (solves 3), add the namespace delete verb (5) and a Workspace state every walker honours (6).

## 5. Design

### 5.1 States

New columns on `teams`: `state` (`active | pending_deletion | deleting | deleted`),
`deletion_requested_at/by`, `deletion_approved_at/by`, `deletion_self_approved`,
`deletion_rule` (the approval rule in force when it was requested), `delete_after` (end of the
grace period), `deletion_started_at`, `deleted_at`, `deletion_progress jsonb` (current step,
cursor, counts, last error), `deletion_summary jsonb` (what the tombstone keeps, §5.14).

```
active ──request──▶ (requested, not approved) ──approve──▶ pending_deletion ──delete_after passed,
  ▲                        │ deny/withdraw                    │ no hold + confirmed──▶ deleting ──verified──▶ deleted
  └────────────────────────┴──────── cancel (any Site admin) ─┘                          │
                                                                                         └─ hold approved: halts in place
```

- The request is a row state, not a separate table: `state` stays `active` until approval, with
  `deletion_requested_*` set (so a denied request leaves the Workspace untouched).
- A guard trigger on `teams` (like `legal_holds_guard`) allows only these transitions; checks the
  approval rule (§5.2: who requested and approved, and whether a self-approval is allowed and
  flagged); refuses `pending_deletion` for the Registry team (`registry = true`), for the last
  non-Registry Workspace of the Site (Q9) and while any legal hold covers the Workspace; refuses
  `deleting` before `delete_after`, while a hold is active, or while a hold released during the
  grace period has not been confirmed again (§5.6); never leaves `deleting` except to `deleted`;
  makes `deleted` final; and freezes `id` forever. The app role keeps UPDATE on `teams` (rename),
  so the trigger, not the server, is the boundary.

### 5.2 Who may delete: the approval rule

A Site setting, **Workspace deletion approval**, chooses between two rules. Only the Site owner can
change it.

1. **Two Site admins** (the default). A Site admin requests, a second Site admin approves. On a
   single-admin Site the requester approves themself and the row is flagged
   `deletion_self_approved` (as break-glass and Registry self-approval).
2. **Site owner only.** The Site owner requests and approves; no second person. Site admins who are
   not the owner cannot request or approve.

The guard trigger reads the setting and stores the rule in force on the request (`deletion_rule`),
so changing the setting later does not alter a pending request. Workspace admins cannot start a
deletion under either rule; they can ask a Site admin outside Kobe. Under both rules **any Site
admin can cancel** during the grace period, alone (stopping a deletion is never the dangerous
direction).

The setting: stored with the other Site settings (default `two_admins`; value `owner_only`),
changed in Site console › Settings by the Site owner only (permission `site.settings.workspace_deletion`,
held by the owner alone), audited as `governance.workspace_deletion_rule.changed` with the old and
new value, and explained in the Site admin guide. Changing the rule is not blocked by a pending
deletion.

### 5.3 Request and confirmation

Site console › Teams › a Workspace › **Delete workspace…** (shown to the people the rule allows)
opens a dialog that shows, before anything is written:

- counts: members (and how many are in no other Workspace), threads, projects, files and bytes in
  storage, agents, skills, schedules, connectors enabled;
- blockers, each with a link: an active or requested legal hold (Workspace, member or Site-wide
  where it touches the Workspace's data), this is the Registry team, this is the last
  non-Registry Workspace, a deletion already requested;
- what is kept: the audit log, legal-hold and break-glass records, Site proposals, the catalog
  skills promoted from it, the tombstone;
- what Kobe cannot delete: backups and versioned bucket copies until they age out, audit
  events already forwarded, anything at connector or git hosts (§5.13), with a pointer to
  `kobe backup` for a full copy before approving (Q8);
- the people left with no Workspace, listed by name: their accounts stay active (Q5), and the
  dialog offers no deactivation;
- the grace period (30 days) and its end date;
- a required reason (stored, audited, like legal-hold reasons);
- confirmation by typing the Workspace's slug.

The approver sees the same summary (recomputed) and types the slug again. Both steps send email to
all Site admins and the Workspace's admins.

### 5.4 During the grace period (`pending_deletion`)

The Workspace is **read-only, not hidden** (Q3).

- Members still see it in the switcher with a banner "This workspace will be deleted on <date>.
  Download your export." They can read threads, files, projects and memories and use **Export my
  data** (`retention/export.ts`); Workspace admins can export Workspace memories.
- Refused with `409 workspace_pending_deletion`: new threads and messages, runs (interactive,
  scheduled, eval, learning passes), uploads, commits, edits, invitations, adding members, SSO/SCIM
  access mappings applying to it (`applyIdpAccess` skips it), skill installs and Default syncs,
  connector and egress changes.
- At approval, in this order: queued and active runs are cancelled through the existing cancel path
  (with a system message); schedules are paused with a new `paused_by = 'workspace_deletion'`;
  sandboxes are hibernated (pods stop, claims and PVCs stay so a cancel loses nothing); run tokens
  revoked; open approvals and egress requests expire; the model sync drops the Workspace from the
  desired state, so Bifrost removes its team and virtual keys; open invitations are revoked.
- Member notices (in Kobe and by email) at approval, 7 days before and 1 day before.
- The member export stays available until `delete_after`; nothing is deleted before then.

**Cancel** (undo): any Site admin, any time before `deleting`; reason required. State back to
`active`, request fields cleared (the audit log keeps the history), schedules with
`paused_by = 'workspace_deletion'` resume, sandboxes wake on next use, the model sync re-creates
virtual keys. Invitations and expired approvals stay revoked/expired.

### 5.5 Members

- Every membership is removed during `deleting` (step 2, §5.7); no offboarding 30-day hold applies
  (the volumes go with the namespace).
- User accounts are never deleted (Kobe rule) and **never deactivated by this feature** (Q5): there
  is no "also deactivate" option in the dialog, the API or the CLI. A person whose only Workspace
  this was stays active and sees the existing "You are not in any team yet" screen
  (`apps/web/components/chat/chat-app.tsx:120`). Their portable memories, personal skills and
  personal agents stay, as for any member removal. Deactivating them is an ordinary Site admin
  action afterwards.
- Site roles are untouched; a Site admin who was a member simply loses the membership.

### 5.6 Legal holds

- Deletion is refused while any **active or requested** legal hold covers the Workspace: a hold on
  the Workspace, on any of its members in it, or a Site-wide hold (it covers Site memory, which a
  Workspace's `run_site_memory_items` point at). The guard trigger and the request API both check.
- A hold approved during `pending_deletion` **blocks the move to `deleting`** (Q11): the Workspace
  stays pending and read-only until the hold is released, then a person the approval rule allows
  (a Site admin under rule 1, the Site owner under rule 2) must confirm again; the grace period
  does not restart. It does not reopen the Workspace for writes: a hold asks to keep data, not to
  resume work on it. Cancel stays available throughout.
- A hold approved during `deleting`: every batch takes `lockLegalHolds` first (KOBE-17 contract) and
  checks `legalHoldsForTeam`; the job stops (`deletion_progress.halted = 'legal_hold'`), alerts Site
  admins, and resumes only after the hold is released and the same confirmation is given. Rows
  already deleted are gone; the KH001 guards back this up for the tables they cover.
- This needs a new rule in the legal-hold docs: "a hold on a Workspace in deletion keeps what is
  left" (D10).

### 5.7 The deletion job

A `ServerJob` named `workspace-deletion` in `startup/jobs.ts`, under its own leader lock
(`kobe.workspace-deletion`), ticking every minute. Each tick picks Workspaces in `pending_deletion`
past `delete_after` with no unconfirmed hold (moves them to `deleting` through the guard) and
Workspaces in `deleting`, and runs steps for a bounded time (10 minutes per tick per Site, one
Workspace at a time). Every step is idempotent and writes its cursor and counts to
`deletion_progress` in the same transaction as the work, so a crash or a new leader resumes exactly
where it stopped.

Every team-table batch runs in `withTeam(teamId)` (no new exception to the team-setting rule), is
a short transaction (`lock_timeout` 5 s, the existing `JOB_STATEMENT_TIMEOUT`), takes the legal-hold
lock first, deletes at most a fixed number of rows (5,000, or the purge's existing
`DEFAULT_BATCH` for threads), and ends with its audit row where the step is audited.

**Deletion plan registry** (`packages/db/src/deletion-plan.ts`): every entry in `TEAM_TABLES`
maps to exactly one step: `purged-by` another step (cascade child), `batch-delete`, or `custom`.
A unit test fails when a team table is missing, like the probe fixtures, so a new table (the
Workspace git connection tables, future areas) cannot be forgotten. A DB test derives the FK graph
from `pg_constraint` and fails if a step deletes a parent before a child that has no cascade.

Steps, in order:

1. **Freeze check.** Re-verify state `deleting`, no hold; cancel any run that slipped through;
   destroy sandboxes (`offboarding/destroy.ts` per member, without the volume hold).
2. **Memberships and access.** Delete `team_invitations`, `sso_access_mappings` for the team
   (site-wide; audited), `session_active_teams` and `user_last_teams` pointers (repoint to another
   membership or clear), `connector_grants` (KOBE-696 rule: delete, no upstream revoke),
   `team_egress` (sealed headers), the Workspace git connections and their sealed credentials,
   `model_gateway_keys`, `run_tokens`, `budget_reservations`; then `team_members` last in this step
   (so the authz middleware refuses everyone from here on). Active break-glass grants on the
   Workspace are revoked (rows kept).
3. **Threads.** `purgeThreads` with `{ kind: "team" }`: cascades entries, runs, run events,
   approvals, feedback, app results, file links, branch labels; blob keys queued.
4. **Projects.** Projects by id, cascading members, files, commits, tree entries, checkouts (and
   Repo state from Workspace git); project objects queued (existing project-key rule).
5. **Files, artifacts, uploads, file memory.** `files`, `artifacts`/`artifact_versions`,
   `memory_docs`/`memory_doc_versions` (keys queued).
6. **Semantic memory.** Learning passes, candidates, dismissals, watermarks, proposals,
   suggestions, reminders, stewards, run memory records, items (versions by cascade, embeddings
   with them).
7. **Agents and skills.** Eval cases and history, Orbit evals, skill eval runs/results, drafts and
   their history, promotion and install requests, installs, opt-outs, blocks, enablements, reviews,
   settings, roster, transfers, suspensions; then `team_skills` and `team_agents` (versions by
   cascade).
8. **Schedules and notifications.** `schedules`, `run_skipped_actions`, `notifications`,
   `notification_emails`.
9. **Scratchspace rows.** `workspace_moves`, `workspace_sync_conflicts`, `workspace_file_hold_history`,
   `workspace_files`, `workspace_blobs`, `workspace_sync`, sandbox wire rows, `sandboxes`.
10. **Usage and budgets.** `run_usage`, `model_spend_daily`, `team_budgets`, `team_models`
    (needs the guard change below). The totals for the tombstone are computed first (§5.14).
11. **Settings.** `tool_rules`, `egress_requests` (+ notifications), `team_connectors`,
    `thread_connectors_off`, `team_storage_quotas`, `team_memory_settings`, `team_eval_settings`,
    `team_retention`, `thread_folders`.
12. **Object storage** (§5.8): drain `retention_blob_deletions`, then delete both prefixes.
13. **Kubernetes** (§5.9).
14. **Site-level settlement** (§5.10).
15. **Verify** (§5.11), write the tombstone summary, release the slug, state `deleted`.

**Guard change** (one migration): `kobe_team_deleting(team uuid)` returns whether that team's
`state = 'deleting'` (invoker rights, pinned `search_path`, reads the site-wide `teams` row). The
immutable and append-only guards on team tables (`run_usage`, `model_spend_daily`,
`team_agent_versions`, `team_skill_versions`, semantic-memory versions, `skill_drafts_keep_deleted`,
the eval `keep_held` guards) also let a DELETE through when `kobe_team_deleting(OLD.team_id)`.
They keep refusing UPDATE, and the KH001 legal-hold guards are not relaxed. Because only the
`teams` guard can set `deleting`, and only after approval, grace and the hold check, the app role
cannot use this to rewrite history in a live Workspace. The site-wide `audit_log` guard is not
touched.

### 5.8 Object storage

- First drain `retention_blob_deletions` for the team with the existing `retention/blobs.ts` pass
  (keys queued by steps 3-5).
- Then a **prefix sweep**, new code modelled on `retention/orphans.ts`: page through
  `ObjectStore.list("<prefix>teams/<team>/")` and `list("<prefix>skills/teams/<team>/")`, delete in
  batches of 100 with `deleteBounded` inside a transaction holding the legal-hold lock (shared),
  after checking that no `site: true` blob column references a listed key (catalog, personal
  skills) and that the team still has no rows in any `thread: true` column. Keys outside the two
  prefixes are never listed or deleted; a key failing a check is left and reported.
- Repeat until a full listing of both prefixes is empty; the cursor and counts go to
  `deletion_progress`. A Site with a shared bucket is safe because only these two prefixes are
  listed (as the orphan sweep's rule).
- On a versioned bucket the objects become noncurrent versions and expire by the bucket's
  lifecycle rule (30 days recommended); without a noncurrent expiry they are never erased (the
  server already warns at start).

### 5.9 Kubernetes teardown

- Chart: add `delete` on `namespaces` to the server's ClusterRole; the existing admission policy
  already confines namespace DELETE to `kobe-team-*`. Add a check that the namespace's
  `team-id` label equals the team being deleted before the call.
- Team reconcile and the sandbox provider skip teams not `active` (a wake for such a team throws
  `workspace_not_active`), so nothing re-creates objects.
- Delete the namespace (foreground propagation). The job polls until it is gone; PVCs go with it
  (StorageClass `Delete`). If it stays `Terminating` for more than 30 minutes the job records the
  remaining resources and finalizers in `deletion_progress`, alerts, and keeps polling; it never
  removes finalizers itself. Operator runbook in `docs/install.md` troubleshooting.
- A namespace that never existed (a Workspace nobody used) is a no-op.

### 5.10 Gateway, proxies and site-level settlement

- Bifrost: already removed at approval (§5.4). Step 14 asserts the model sync's last result has no
  Bifrost team or virtual key for the team.
- NOTIFY the egress and MCP proxies with the team hint so caches drop it.
- `site_memory_proposals` from the Workspace (Q6): open ones are withdrawn or expired with the
  usual notices and audit entries (as `docs/guide/memory.md` requires); **decided proposals are
  kept**; all rows stay, pointing at the tombstone (RESTRICT stays satisfied because the team row
  stays).
- Registry (Q6): pending submissions from the Workspace are withdrawn; **approved catalog skills
  stay** in the catalog; `registry_versions.source` keeps naming the tombstone, shown to reviewers
  as "deleted workspace <name>". Retiring a catalog skill stays a separate catalog action.
- `budget_alerts`, `legal_holds`, `break_glass_grants`, `audit_log`: kept.
- Personal agents assigned to the roster: only the roster rows went (step 7).

### 5.11 Verification ("nothing left")

Before `deleted`, in one read-only `withTeam(teamId)` transaction: `SELECT EXISTS (… WHERE team_id
= $1)` for every `TEAM_TABLES` entry (RLS confines it to the team anyway); site-wide checks
(`sso_access_mappings`, session pointers, team-scoped `connector_grants` none); both object
prefixes list empty; the namespace is gone; the model sync has nothing for the team. Any failure
leaves the state `deleting` with the failing check named, and the job retries the step that owns
the table. Only a fully clean check writes `deleted_at`, the summary and `governance.workspace.deleted`.

### 5.12 Audit trail

New events (allowlisted fields: team id, requester/approver, approval rule, reason length or hash
per existing practice, counts, step names; never content):
`governance.workspace_deletion.requested`, `.approved` (with `self_approved` flagged when it
applies), `.denied`, `.withdrawn`, `.cancelled`, `.started`, `.halted` (hold, failure), `.resumed`
(including the renewed confirmation after a hold), `.step_completed` (one per step with counts),
`governance.workspace.deleted`, and `governance.workspace_deletion_rule.changed` for the Site
setting (§5.2). Site-scope, with `team_id` set where a Workspace is involved, so they show in the
Site log.

The audit log is kept: rows with the deleted team's `team_id` stay in `audit_log` forever (no
delete path exists or is added). IP and user agent are erased on the usual schedule (12 h
default) unless a hold covers them. The Workspace's own **Audit view** disappears with its
members; Site admins read the rows in the Site log, where team-internal ids are already hidden
(`docs/guide/admin/site-admin.md`, Governance). No extra anonymised copy is made (Q7); the
tombstone summary carries the totals.

### 5.13 Backups

Deleted data persists in every `kobe backup` taken before the deletion, in CNPG/managed Postgres
backups and in the bucket's noncurrent versions, until the operator's retention removes them. Kobe
does not reach into backups. The dialog, the guide and `docs/backup-restore.md` say so. Restoring
a backup taken before the deletion brings the whole Site back to that point, including the
Workspace's rows; its objects are then missing unless their noncurrent versions are still there,
and the restore stops on the missing objects unless `--allow-object-mismatch` is passed. That is
the only way to "undo" after `deleting` started; documented as such.

### 5.14 Tombstone

The `teams` row stays with `state = 'deleted'`: id, name, `created_at`, request and approval
fields, `deleted_at`, and `deletion_summary` (Q7: counts per area, bytes deleted, total spend and
tokens by month, first and last activity). `settings` is cleared. Ids are random UUIDs and never
reused; the row also keeps every governance reference valid. The slug is released at `deleted`
(Q4) by rewriting it to `deleted-<first 20 hex of id>` (fits the slug check), because the
namespace is gone and a new "finance" Workspace should be possible; the audit rows name the team
by id, and the Site console shows the old name from the row.

Every team walker (§4 item 6) filters `state = 'active'` (or `IN ('active','pending_deletion')`
where the walker must still act during the grace period, e.g. notices); the Site console lists
deleted Workspaces under a **Deleted** filter with their summary.

### 5.15 Site console, API, CLI and admin MCP

- Site console › Teams: a state column (Active, Pending deletion until <date>, Deleting <step>,
  Deleted); **Delete workspace…**, **Approve deletion**, **Deny**, **Cancel deletion**,
  **Retry/Resume** and **Confirm deletion** (after a halt, a failure or a released hold); a
  progress panel with step, counts, last error (message only). Actions that need the approval
  rule are shown only to the people it allows. Site console › Settings: the approval rule (§5.2),
  editable by the Site owner only.
- Team console: banner for Workspace admins during the grace period; no actions.
- Admin MCP: `site_teams_list` returns the state and `delete_after`; **no** tool requests,
  approves or cancels a deletion, or changes the rule. `docs/specs/kobe-admin-mcp.md` §9 already
  keeps "retention and deletion" and two-person actions in the consoles.
- API: `POST /v1/site/teams/:id/deletion` (request), `POST …/deletion/approve`, `…/deny`,
  `…/cancel`, `…/resume`, `GET …/deletion` (summary, blockers, progress), and
  `GET|PUT /v1/site/settings/workspace-deletion` for the rule. Permission `site.teams.delete`
  (request, approve, deny, resume) is held by Site admins and the owner and narrowed by the rule:
  under rule 2 the server refuses everyone but the owner. Cancel needs `site.teams.delete_cancel`,
  held by every Site admin.
- CLI (Q10): `kobe workspace deletion-status [<slug>]` shows state, step, counts, halts and last
  error; `kobe workspace deletion-resume <slug>` resumes a halted job. Both call the API as a Site
  admin (the owner under rule 2), so the approval rule and audit apply; the CLI cannot request,
  approve or cancel.

### 5.16 Failure handling and observability

- Step failures are retried with backoff (1 min doubling to 1 h); after 10 failures in a row the
  job halts the Workspace (`halted = 'failed'`), emails Site admins and waits for **Resume**.
- Logs: one line per batch with team id, step, rows, objects, duration; never names or content.
- Metrics (existing telemetry, when configured): `kobe_workspace_deletion_rows_total{step}`,
  `kobe_workspace_deletion_objects_total`, `kobe_workspace_deletion_halted` gauge, step duration.
- `kobe_retention_paused` (`KOBE_RETENTION_PAUSED`) also pauses this job (after a restore nothing
  may delete until the operator says so).
- The job stops at shutdown between batches (the drain in `index.ts`).

### 5.17 Docs (CLAUDE.md "user-facing docs" rule)

Same PRs as the code: `docs/guide/admin/site-admin.md` (Teams: delete, approve, cancel, deleted
filter, the approval rule setting; drop "Kobe has no way to delete a workspace"), `docs/guide/memory.md`
(proposals paragraph: what deletion now does), `docs/guide/reference/retention-and-deletion.md` (a
section "When a workspace is deleted": grace, read-only, export, accounts stay active, backups),
`docs/guide/admin/team-admin.md` (banner), a member-facing note in `docs/guide/getting-started`
(the banner and export), glossary ("Pending deletion", "Workspace deletion approval"), the For
agents pages (runs refused with `workspace_pending_deletion`), `docs/audit-log.md` (events),
`docs/backup-restore.md` (deleted data in backups), `docs/install.md` (RBAC change, stuck namespace
runbook, the CLI), `docs/guide/admin/admin-from-a-conversation.md` (deletion stays in the
console), the legal-hold docs (D10), release notes.

## 6. Security and tenancy notes

- No new exception to "only `withTeam()` sets the team": every team-table write is in `withTeam`;
  `teams`, `sso_access_mappings`, session pointers are site-wide tables the app role already writes.
- The `deleting` state widens what the app role may delete in that one team only, and only the
  `teams` guard trigger can set it (approval, grace, hold check). The cross-team probe suite gets a
  case: a team in `deleting` lets nothing through for another team's rows.
- The namespace delete verb is the riskiest chart change: label check in code, admission policy in
  the cluster, and a server-side dry run in the existing admission self-check that a delete of a
  non-`kobe-team-*` namespace is refused.
- The approval rule is enforced by the guard trigger, not only by the API, and only the Site owner
  can change it. Rule 2 shrinks the set of people who can destroy a Workspace; rule 1 keeps two
  people for an irreversible act, as for legal holds and break-glass.
- The CLI and API add no way to deactivate accounts or to skip grace, holds or approval.

## 7. Out of scope

Deleting users and deactivating accounts as part of a Workspace deletion; per-Workspace restore
from a backup; a full Workspace export for admins (beyond members' own exports and the memory
export; Q8); revoking credentials at connector or git hosts; erasing data in backups; deleting a
Scratchspace alone; merging or moving Workspaces; Workspace admins starting a deletion; a
configurable grace period; retiring catalog skills a Workspace promoted.

## 8. Acceptance

1. A Workspace with threads, projects, files, memories, agents, skills, schedules, connector
   grants, a git connection and a used sandbox goes through request, approval, grace (shortened by
   a test setting), `deleting` and `deleted`; the verification passes; both object prefixes are
   empty; the namespace is gone; Bifrost has no team or key for it; its slug can be used again.
2. Another Workspace's rows, objects, namespace and gateway state are unchanged (counted before and
   after), including a Workspace whose slug sorts next to it.
3. Under rule 1 a second Site admin must approve (a single-admin Site self-approves, flagged in the
   audit event); under rule 2 only the Site owner can request or approve; only the Site owner can
   change the rule, and the change is audited; a pending request keeps the rule it began under.
4. A legal hold (Workspace, member, Site-wide) blocks the request; a hold approved during grace
   keeps the Workspace pending and read-only and a new confirmation is needed after release; a
   hold approved mid-deletion halts the job between batches; nothing covered by the hold is deleted.
5. The last non-Registry Workspace and the Registry team cannot be deleted.
6. Cancel during grace restores the Workspace (runs and schedules resume; virtual keys re-created).
7. Killing the leader mid-step and restarting resumes with no error and no leftover.
8. The plan coverage test fails when a new team table is added without a step.
9. The audit log verifies (`verifyAuditChain`) after deletion and holds every event of §5.12.
10. Members in no other Workspace stay active and see "not in any team"; nothing in the dialog,
    API or CLI deactivates them.
11. Approved catalog skills and decided Site memory proposals from the Workspace remain; pending
    submissions are withdrawn; the tombstone shows the totals.
12. The guide pages in §5.17 are updated; `/llms.txt` lists them.

## 9. Decisions

| Id  | Decision                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Deletion is a Site action governed by a Site setting: (1) a Site admin requests and a second Site admin approves, a single-admin Site self-approves, flagged (default); or (2) the Site owner only (§5.2).                   |
| D2  | States `active → pending_deletion → deleting → deleted`, enforced by a guard trigger on `teams`; `deleting` and `deleted` are one-way.                                                                                       |
| D3  | The `teams` row is never deleted: it becomes the tombstone, keeping legal-hold, break-glass, audit and Site-proposal references valid and the id unreusable.                                                                 |
| D4  | A fixed 30-day grace period before any deletion, with cancel by any Site admin alone.                                                                                                                                        |
| D5  | During grace the Workspace is read-only: no runs, schedules paused, sandboxes hibernated, Bifrost keys removed, banner shown, member export open.                                                                            |
| D6  | Deletion is refused while any active or requested legal hold covers the Workspace (Workspace, member, Site-wide); a hold during grace keeps it pending and needs a new confirmation; a hold during `deleting` halts the job. |
| D7  | One resumable `ServerJob` deletes table by table in bounded `withTeam` batches, legal-hold lock first, progress stored with the work.                                                                                        |
| D8  | A deletion plan registry maps every `TEAM_TABLES` entry to a step; a test fails on a missing table; a DB test checks FK order.                                                                                               |
| D9  | Immutable and append-only team-table guards also allow DELETE while their team is `deleting`; UPDATE stays refused; KH001 guards and `audit_log` unchanged.                                                                  |
| D10 | A hold placed on a Workspace in deletion keeps what is left; documented in the legal-hold docs.                                                                                                                              |
| D11 | Object storage: drain the release queue, then sweep exactly `teams/<id>/` and `skills/teams/<id>/` with the existing bounded deleter and reference checks.                                                                   |
| D12 | Kubernetes: the server gets `delete` on namespaces (admission already confines it); it never removes finalizers; stuck namespaces are reported.                                                                              |
| D13 | Connector grants, egress headers and git credentials are deleted without any upstream revoke (KOBE-696 rule).                                                                                                                |
| D14 | Memberships are removed; user accounts are kept and stay active, with no deactivation option anywhere.                                                                                                                       |
| D15 | The audit log keeps every row of the Workspace; new `governance.workspace_deletion.*` events record each step with counts.                                                                                                   |
| D16 | Backups and versioned bucket copies keep deleted data until they age out; Kobe states this in the dialog and the guide and does not touch them.                                                                              |
| D17 | A "nothing left" verification over every team table, both prefixes, the namespace and the gateway gates the `deleted` state.                                                                                                 |
| D18 | The Registry team cannot be deleted.                                                                                                                                                                                         |
| D19 | Every walker of all teams filters on state; the Site console lists deleted Workspaces separately.                                                                                                                            |
| D20 | No admin MCP tool requests, approves or cancels a deletion or changes the rule; `site_teams_list` shows the state.                                                                                                           |
| D21 | `KOBE_RETENTION_PAUSED` also pauses the deletion job.                                                                                                                                                                        |
| D22 | The approval rule is a Site setting changed by the Site owner only, audited, read by the guard trigger and stored on each request.                                                                                           |
| D23 | The last non-Registry Workspace of a Site cannot be deleted.                                                                                                                                                                 |

## 10. Decided questions

Chris, 2026-11-22. Each answer is applied in the sections above.

| Q   | Question                                  | Answer                                                                                                                                                            | Date       |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q1  | How long is the grace period?             | 30 days, fixed.                                                                                                                                                   | 2026-11-22 |
| Q2  | Who may delete?                           | A Site setting chooses between a Site admin plus a second Site admin (default; self-approve on a single-admin Site, flagged) and the Site owner only. Changes D1. | 2026-11-22 |
| Q3  | What do members see during the grace?     | A read-only Workspace with a banner and the member export.                                                                                                        | 2026-11-22 |
| Q4  | Is the slug reusable?                     | Released when the Workspace reaches `deleted`.                                                                                                                    | 2026-11-22 |
| Q5  | Members who belong to no other Workspace? | Accounts stay active; no "also deactivate" option (the proposal's optional deactivation is dropped).                                                              | 2026-11-22 |
| Q6  | Site-catalog items from the Workspace?    | Keep approved catalog skills; withdraw pending submissions; keep decided Site memory proposals.                                                                   | 2026-11-22 |
| Q7  | Keep a usage and audit summary?           | Existing records plus totals on the tombstone.                                                                                                                    | 2026-11-22 |
| Q8  | Export before delete?                     | Members export their own data; the dialog points to `kobe backup`.                                                                                                | 2026-11-22 |
| Q9  | May the last Workspace be deleted?        | No: the last non-Registry Workspace cannot be deleted.                                                                                                            | 2026-11-22 |
| Q10 | UI in v1, or CLI first?                   | Site console UI and API, plus a small status and resume CLI.                                                                                                      | 2026-11-22 |
| Q11 | A hold placed during the grace period?    | The Workspace stays pending and read-only; a Site admin confirms again after the release.                                                                         | 2026-11-22 |
| Q12 | Order against the queued work?            | After the rename: review tickets, Workspace git, rename, then this.                                                                                               | 2026-11-22 |

## 11. Tickets

All tickets start after the rename has merged (start condition above). E2E means a browser or
cluster test is part of the ticket.

| Phase | Id    | Ticket                                                                                                                                                                                                                                                           | Size | Depends    | E2E       |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | --------- |
| 1     | DW-1  | `teams` state columns, approval-rule Site setting (owner-only change, audited), `teams` guard trigger (transitions, approval rule, Registry, last Workspace, hold check, re-confirmation after a hold), audit events, probe and guard DB tests                   | M    | -          | no        |
| 1     | DW-2  | State everywhere: authz middleware refuses non-active (read-only routes allowed in pending), `scanTeams` and the ~55 team reads filtered, scheduler, default syncs, rescans, SSO/SCIM apply, invitations, sandbox wake, team reconcile, model sync desired state | L    | DW-1       | no        |
| 2     | DW-3  | Request, approve, deny, cancel, confirm API and permissions under both rules; side effects at approval (runs cancelled, schedules paused, sandboxes hibernated, invitations revoked); cancel restores; notices and emails                                        | M    | DW-2       | yes       |
| 2     | DW-4  | Site console: Teams state column, Delete dialog with counts, blockers and the `kobe backup` pointer (no deactivation option), approve/deny/cancel/confirm, Deleted filter, rule setting; Workspace banner and read-only UI                                       | M    | DW-3       | yes       |
| 3     | DW-5  | Deletion plan registry (covering the Workspace git tables) and coverage test; FK-order DB test; guard migration (`kobe_team_deleting`) with probe cases                                                                                                          | M    | DW-1       | no        |
| 3     | DW-6  | `workspace-deletion` ServerJob: leader lock, ticks, progress, retries, halts, resume; table steps 1-11 reusing the purge modules (thread selection `team`)                                                                                                       | L    | DW-5, DW-3 | no        |
| 3     | DW-7  | Object storage: queue drain and prefix sweep with reference checks and caps                                                                                                                                                                                      | M    | DW-6       | no        |
| 3     | DW-8  | Kubernetes teardown: chart RBAC `delete` on namespaces, label check, admission self-check case, polling and stuck reporting                                                                                                                                      | M    | DW-6       | yes (k3d) |
| 3     | DW-9  | Site-level settlement (proposals withdrawn or kept, registry submissions withdrawn, break-glass, mappings, pointers), verification, tombstone with totals and slug release                                                                                       | M    | DW-6..8    | no        |
| 4     | DW-10 | Status and resume CLI, metrics, runbook; docs pages of §5.17; release notes                                                                                                                                                                                      | M    | DW-9       | no        |
| 4     | DW-11 | Browser spec on the test install: create a Workspace, use it, request, approve, check banner and read-only, shortened grace, deletion, verify, second Workspace untouched, slug reuse                                                                            | M    | DW-4, DW-9 | yes       |
| 4     | DW-12 | Gate: fresh deletion on the test install with a real used Workspace, `pnpm license:gate`, review                                                                                                                                                                 | S    | all        | yes       |

Total roughly L+ (two L, eight M). DW-5 can run parallel to DW-2..4.

## 12. Risks

- **A walker missed by DW-2** keeps acting on a pending or deleting Workspace (for example a Default
  sync installing a skill, or a wake re-creating a namespace after teardown). Control: a DB test
  that runs every `ServerJob.once()` against a Workspace in each state and asserts no writes to it;
  the verification step catches leftovers.
- **Relaxed immutable guards** (D9) are a new way to delete history. Control: only the `teams` guard
  sets `deleting`; probe tests per guard; UPDATE stays refused; KH001 untouched.
- **Namespace delete RBAC**: a bug could delete the wrong namespace. Control: admission policy limits
  to `kobe-team-*`, label equals team id check, one namespace per Workspace by name.
- **Stuck namespace** (finalizers, Longhorn detach failures seen on the test install): the job
  waits and reports; an operator fixes it. No automatic finalizer removal.
- **Long deletions**: a Workspace with millions of entries takes many ticks; the retention pass and
  the deletion job share the database. Control: per-tick budget, one Workspace at a time, batch
  sizes from the purge code, run off-peak if needed (setting).
- **Legal-hold race**: a hold approved between check and delete. Control: legal-hold lock first in
  every batch (KOBE-17 contract), KH001 guards.
- **Restore after deletion** brings back rows without objects; documented, and the restore already
  refuses missing objects by default.
- **Data outside Kobe** (SIEM copies, backups, upstream services) cannot be deleted; the dialog
  says so, which may surprise anyone expecting a full erasure.
- **New team tables** added in parallel lanes, and Workspace git's tables: the coverage test fails
  until they get a step; the start condition makes DW-5 check them first.
- **Approval rule switched to owner-only** on a Site whose owner is unreachable leaves no one able
  to delete; cancel stays with every Site admin, so nothing destructive is stranded.
- **Accounts left with no Workspace** stay active and see an empty state until a Site admin adds
  them elsewhere or deactivates them by hand.
