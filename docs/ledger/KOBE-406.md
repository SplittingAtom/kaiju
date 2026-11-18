# KOBE-406: SMC5: Wall probe — no thread-derived text crosses to the Site

- **Status:** committed locally on `kobe-406-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-406-sm` in `../Kobe-wt406` (on `kobe-403-sm`)
- **Depends on:** KOBE-402 (table), KOBE-403 (service/API)

## Plan

Tests only; no production code, no migration, no protocol change.

- `services/server/src/testing/site-wall-probe.ts`: the reusable probe (`canary`, `findLeaks`,
  `SiteWallProbe`, `siteTableRows`, `FORBIDDEN_FIELDS`), cited by Gate C.
- `services/server/src/site-wall-probe.db.test.ts`: seeds, entry points, read paths, mutation check.
- `docs/gates/gate-7c.md`: stub with the "Wall probe (KOBE-406)" section (KOBE-407 fills the rest).

## Decisions

- **Detector:** case-insensitive substring search over every string and key of every value
  (rows as `row_to_json`, API JSON, CSV text, mail objects), plus forbidden field names with a
  non-empty value. Shape-agnostic on purpose: a new column, field or path that copies thread
  text fails without the probe knowing it. Canaries are `kwp<label><hex>` (FTS keeps them whole).
- **Rows:** every `public.site_memory%` table, discovered from `information_schema`, so a table
  added later is probed automatically.
- **Real passes:** `POST /v1/threads/:id/learn` with the server's own learning passes and a
  scripted gateway `fetch` (as `memory-learn-route.db.test.ts`). The extractor echoes the
  assistant/tool canaries and the thread id into `rationale`; the evidence quote is the person's
  words (needed for Workspace/Site candidates). The test asserts the candidates really carry them.
- **Admin MCP (KOBE-650):** the tools' own `route` + `reduce` through `routeCaller` (the
  executor's delegated in-process call) for a Site admin with a running run: exercises the route's
  agent read path and the tool's serializer without the MCP proxy harness.
- **Run context:** `buildRunSemantic` + `readRecallRows` for a plain member's run; only the Site
  lane (and Policy) is probed: Workspace items are not Site data.
- **Exports:** the Site memory export (`POST /v1/memory/semantic/export {scope: site}`, JSON and
  CSV, inactive included). The personal export (KOBE-649) leaves Site items out by design
  (`memory/items-export.ts`), so it is not a Site read path.
- **Scoping (by-design exclusions, documented in the test):**
  - The site audit API lists every Workspace's events (D6), e.g. `memory.pass.*` with thread ids:
    the probe takes the Site log's `memory.*` events and the Workspace log's
    `memory.site_proposal.*` events.
  - The Workspace's own `memory.site_proposal.created` audit entry names the candidate it closed
    (KOBE-403): candidate ids are allowed there only; text canaries and thread/run/entry/pass ids
    are still checked.
  - The bell API also lists the person's own `memory.review.candidates_ready` (names their
    thread by design): only Site proposal notices (and digests/reminders of them) are probed.
- **Mutation check (ac-2):** no seam needed. (1) Detector test: an `evidence` field injected into
  a view is named (field + canary). (2) Corrupted fixtures: one proposal's justification gets the
  rationale canary, one Site version's statement the quote canary (immutable-version trigger
  skipped with `session_replication_role = replica` on the test's superuser session only); the
  probe must report the DB rows, Site queue/detail, Workspace detail, item detail for members and
  another Workspace, both MCP tools, both exports and recall. Restored, then clean again.
  Positive controls also show each path really serves the confirmed text.

## Leaks found

None. Every Site read path held only the confirmed statements and justifications.

## User-facing docs

No guide change: tests and a gate doc only; nothing a member, admin or agent sees changes.

## Open questions (for Chris or the coordinator)

1. Site admins read every Workspace's audit events through `/v1/site/audit` (D6), including
   `memory.site_proposal.created {candidateId}` and `memory.pass.*` with thread ids. Ids only, no
   text, and site audit is governance, not Site memory; flagging for Gate C in case SM20 is meant
   to cover the audit view too.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `site-wall-probe.db.test.ts` "ac-1: no canary or thread-derived field on any Site read path".
- **ac-2** same file, "mutation check (ac-2)" (two tests).
- **ac-3** `docs/gates/gate-7c.md` § Wall probe (KOBE-406).
