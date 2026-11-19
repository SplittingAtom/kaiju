# KOBE-676: SIEM forwarding and the Site audit page follow the Site audit wall

- **Status:** committed locally on `kobe-676-siem` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-676-siem` in `../Kobe-wt676`, from `origin/main` (e324bb1f)
- **Depends on:** KOBE-666 (Site view), KOBE-406 (wall probe), KOBE-19/182 (forwarder). **Migration:** none.

Chris, Gate 7 answers 1–2 (2026-11-19).

## Plan

1. `audit/forward/forwarder.ts`: every batch goes to the sinks as `page.events.map(siteViewEvent)`
   (the KOBE-666 function, one source of truth). Workspace events (`teamId` set) lose every
   non-allow-listed target key; Site-level events unchanged. Both sinks (syslog, OTLP) format
   what they receive, so one change covers both.
2. Site console › Audit log: a muted paragraph at the top of the Events section
   (`WORKSPACE_HINT_TEXT`, `components/admin/site/audit-page.tsx`).

## Decisions

- **Integrity.** The forwarder signs nothing; it forwards the stored row's `hash`/`prev_hash`. Kept
  as is: the links (`prev_hash` = previous `hash`) and the anchored head still check in a SIEM; a
  Workspace row's hash covers the stored row, so it is recomputed with
  `GET /v1/site/audit/integrity`. No "trimmed" marker field added (a Workspace event is
  recognisable by `teamId`; no wire-format change). Documented in `docs/audit-log.md`.
- **Cursor and order unchanged:** trimming is per event after the page read, so `seq` cursor,
  de-duplication on `id` and backoff behave as before.
- **Hint wording uses the UI's real labels:** "Team console › Audit view" (the brief said
  "Workspace console › Audit"; the console and nav label are "Team console" / "Audit view").
  Text only, no link: a Site admin is not necessarily a team admin.
- The hint is plain text in reading order before the table (no live region, not hidden).

## User-facing docs

- `docs/audit-log.md`: Export and forwarding (what is forwarded, integrity of forwarded events),
  Site view of Workspace events (forwarding included, the page's note, probe scope).
- `docs/install.md`: new "Audit forwarding (SIEM)" subsection; `charts/kobe/values.yaml` comment.
- `docs/guide/admin/site-admin.md`: Audit log (export and forwarding, the note) and Audit forwarding.

## Evidence

- **ac-1** `audit-export.db.test.ts` › "forwards Workspace events in the Site view, Site-level
  events as stored (KOBE-676)" (thread/run ids dropped; stored row keeps them; hashes are the
  row's; links hold). `site-wall-probe.db.test.ts` ac-1 now forwards every event from seq 0 through
  the real `AuditForwarder` into a fake sink and probes `siem:events`, `siem:syslog`, `siem:otlp`
  (positive controls: `memory.site_proposal.created`, `memory.pass.completed`). Mutation: with the
  trim removed both tests fail (`siem:events` leaks).
- **ac-2** web `site-audit-page.test.tsx` › "says Workspace events show only Site-safe details…";
  guide and audit-log docs above.
