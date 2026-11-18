# KOBE-402: SMC1: Site memory proposals schema

- **Status:** committed locally on `kobe-402-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-402-sm` in `../Kobe-wt402`
- **Depends on:** KOBE-401

## Plan

Schema + one generated migration + tests, nothing else (Phase C's only migration; lands alone).

- `packages/db/src/schema/site-memory-proposals.ts` (new file per `docs/parallel-work.md`; the brief
  named `semantic-memory.ts`, which is already 486 lines) + one `export *` line.
- `packages/db/drizzle/0233_site_memory_proposals.sql` (drizzle-kit generate). No custom migration:
  a site-wide table has no RLS or policy, and app-role grants come from the tenancy registry
  (`migrate.ts`), as for `site_memory_items`.
- Registry: `tenancy/memory.ts` `siteWide` + `grants` + `teamReferencing` (it has an FK to `teams`,
  which the catalog check only allows for registered team-referencing site tables).

## Decisions

- **Site-wide, not RLS.** No `team_id`; `from_team_id` is a plain FK column. Classified like
  `site_skill_settings` / `sso_access_mappings` (site-wide + team-referencing with a reason). No
  probe fixture: the cross-team probe covers team tables only.
- **Grants: SELECT, INSERT, UPDATE (no DELETE).** Withdrawn/expired/decided rows are history; a
  sweep sets `expired`. Rows leave only with their Workspace via cascade (referential actions run
  as the table owner). A later ticket that needs DELETE adds it in the registry.
- **ON DELETE:**
  - `from_team_id → teams` **CASCADE**: the statement + justification are the Workspace's words;
    a deleted Workspace takes its proposals (as `memory_proposals` / every team table).
  - `proposer_id`, `team_confirmed_by`, `decided_by → users` **NO ACTION**: users are deactivated,
    never deleted (same rule as `memory_proposals` and `skill_promotion_requests`). SM28 erasure of
    a proposer therefore keeps the row and the person reference; there are no evidence, quote or
    thread columns to erase. If SM28 later wants a proposer's name off Site rows, the service can
    reassign/anonymise like other user-referencing tables; no schema change needed now.
  - `merged_into → site_memory_items` **SET NULL**: a purged Site item keeps the proposal record
    (state stays `merged`); the `merged` check is "merged_into only when merged", not "merged needs
    merged_into", so the cascade cannot violate it.
- **merged_into targets `site_memory_items`, not `semantic_memory_items`** (the brief's wording):
  `semantic_memory_items` is the Workspace team table (team_id NOT NULL, RLS); Site items live in
  site-wide `site_memory_items` since KOBE-376.
- **Checks (ac-1):** state over the 8 listed states; `rounds BETWEEN 0 AND 3`; kind over the 5
  kinds; statement 1..500 (trimmed non-empty); justification **NOT NULL** 1..1000; reason NULL or
  1..1000; `awaiting_site|approved|merged` need `team_confirmed_by`; `changes_requested|approved|
merged|rejected` need `decided_by` + `decided_at` (a Team admin's rejection or the Site's).
  Added `team_confirmed_at`, `decided_at`, `created_at`, `updated_at` timestamps beyond the brief.
- **Expiry:** `expires_at` defaults to now() + 30 days (reuses `MEMORY_PROPOSAL_TTL_DAYS`).
- **Indexes:** `(state, created_at)` Site queue; `(from_team_id, state, created_at)` Workspace
  queue; `(proposer_id, created_at)`; `expires_at` partial on open states (sweep);
  `merged_into` partial (FK delete check).
- **No FK from `site_memory_item_versions.proposal_id`** yet: versions are immutable (trigger) and
  `actor_kind = 'proposal'` ⇔ `proposal_id IS NOT NULL`, so neither SET NULL nor NO ACTION works
  with the Workspace cascade above (NO ACTION would block deleting a Workspace whose proposal was
  accepted). Left keyless, as KOBE-376 planned.
- **No legal-hold guard** on this table: it holds no thread content; Site items themselves are
  guarded by the Site legal hold (0225). See open questions.

## User-facing docs

None: schema-only change, nothing a member, admin or agent can see or do yet. The Site proposal
flow's docs come with its service/UI tickets (KOBE-403 onward).

## Open questions (for Chris or the coordinator)

1. Should a Workspace legal hold covering the proposer block the team-delete cascade of their
   proposals (like `memory_project_suggestions`)? Not added: a held team cannot be deleted anyway
   (team-level hold guards), and proposals carry no quotes.
2. Justification is required (NOT NULL). If KOBE-403 wants it optional, relax the check there.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `packages/db/src/site-memory-proposals.db.test.ts` "site_memory_proposals (ac-1)": state,
  rounds, text limits, confirmation/decision, merged_into, FKs, grants, indexes.
- **ac-2** same file, "carry no team content (ac-2)": fails if a column matching
  evidence/rationale/quote/thread/entry/run is added; also asserts the FK set.
- **ac-3** `catalog.db.test.ts` "has no SECURITY DEFINER functions" (green); the migration adds no
  function at all.
- Registry: `packages/db/src/tenancy.test.ts` (KOBE-402 case); catalog + probe suites green.
