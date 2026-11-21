# KOBE-701: Split packages/db audit/events.ts into audit/events/<area>.ts

- **Status:** in review (group 52)
- **Branch / worktree:** `group-52-audit-split-team-guard` in `../Kobe-g52`
- **Depends on:** none

## Plan

Pure move along the review's SPLIT-1 (CODE-1): shared zod fragments and the `event()` helper to
`audit/events/fragments.ts`, exported tuples to `audit/events/vocab.ts`, one `as const` object
per area (14 files, taxonomy order kept), `events.ts` spreads them into `AUDIT_EVENTS`.

## Decisions

- Area files follow the existing banners, in the original order, so `AUDIT_ACTIONS` keeps its
  exact order: identity (auth, identity, SSO), platform (site, platform, policy, sandbox
  lifecycle), egress, models, mcp, threads (schedule, thread, project, Workspaces), governance
  (retention, break-glass, legal hold, audit), runs (run, approval), sandbox-wire (wire,
  workspace sync, files, offboarding), agents, skills, connectors, memory, connector-grants
  (grants, retired web search, Kobe connector level).
- `events.ts` re-exports `vocab.ts` and `AuditScope`, so `audit/index.ts` and every import of
  `./events.js` are unchanged. New `AUDIT_EVENT_AREAS` (not exported from the package) feeds the
  duplicate-key test.
- `apps/web/.../audit-categories.test.ts` read `events.ts` by path; it now reads every file in
  `audit/events/`. `docs/audit-log.md` names the new layout. No generator reads the file.
- Guide: no change (no member- or admin-visible change).

## Evidence (acceptance criteria → test or command output)

- ac-1: largest file under `packages/db/src/audit` is `events/skills.ts` (647 lines); public
  exports of `audit/index.ts` unchanged.
- ac-2: `events.test.ts` "audit event areas (KOBE-701)": `expectTypeOf<AuditAction>()` equals the
  union of the area keys; runtime: key count equals the sum of the parts and `AUDIT_ACTIONS`
  equals the concatenated area keys (dropping one spread fails both, checked by hand).
- Move check: the concatenated area bodies are line-for-line the old object body (diff empty).
- ac-3: `pnpm verify` green.
