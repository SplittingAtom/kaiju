# KOBE-666: Site proposals: confirmer may not decide, one reminder, Site audit hides thread ids

- **Status:** committed locally on `kobe-666-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-666-sm` in `../Kobe-wt666`, from `origin/main` (8b3a3055)
- **Depends on:** KOBE-403, KOBE-406, KOBE-653 (all merged). **Migration:** none.

Chris, Gate C answers 2026-11-19, decisions 2-4 (see `docs/gates/gate-7c.md`, now marked answered).

## Plan

1. **Confirmer barred (decision 2).** `memory/proposals/site/access.ts`: `decideBlocked(who, p)`
   → `own_proposal` | `confirmed` | null; `assertSiteDecider` refuses both (403
   `memory_not_allowed`). `rows.ts` gains `confirmerIds`: `team_confirmed_by` plus the actors of
   the Workspace's `memory.site_proposal.confirmed` audit events for the proposal (any round:
   `team_confirmed_by` keeps only the last). Site view gains `may: {decide, decide_blocked}`.
   Site console: all four actions shown disabled with the reason (`aria-describedby`), for one's
   own proposal too (was: text only).
2. **Site audit inside the wall (decision 3).** `audit/site-view.ts`: Workspace events
   (`teamId` set) in `GET /v1/site/audit` and `/v1/site/audit/export` keep only allow-listed
   target keys (`SITE_VIEW_TARGET_KEYS`, 256 keys); hidden: thread/entry/run/pass/candidate/
   suggestion/tool-call/approval/artifact/eval-case ids, per-thread counts, `fromConversation`,
   folder ids and names, `viaAgent` (22 keys + `thread_folder.*` `name`). Unclassified keys are
   dropped; `site-view.test.ts` fails until every key declared by a team/any event is classified.
3. **One reminder per step (decision 4).** The weekly re-arm lived in
   `notifications/site-proposal-relay.ts` (not `retention/site-proposals.ts`, which only expires):
   removed. Relayed reminders are now due 7 days after the confirmation (the step's start), as
   KOBE-403's own; settle unchanged.

## Decisions

- **Confirmer history from the audit log**, not a new column (no migration). The audit log has no
  RLS and is append-only; proposals live ≤ 30 days, so retention never removes the history first.
  Indexed by `action`.
- **Reminders for barred people:** `noticeConfirmed` no longer registers the confirmer's reminder;
  at send, `mayDecide` drops a `confirmed` reminder for the proposer or any-round confirmer (an
  earlier round's confirmer who is a Site curator would otherwise be reminded).
- **Only curator is the confirmer/proposer:** the proposal waits and expires after 30 days
  (documented in the guide, `access.ts`). No fallback.
- **Scope of decision 3:** every Workspace-origin event in the Site view, not only `memory.*`
  (a thread id from `thread.*` or `approval.*` is the same wall). Site-level events unchanged
  (a Site admin's own via-agent record stays). The export is redacted too (Site admins download
  it); its `hash` still covers the stored row, so offline chain checks of Workspace rows need the
  integrity endpoint. SIEM forwarding and the Workspace's own log keep the full record.
- `kobe-mcp-web.db.test.ts` updated: the Site view no longer shows a Workspace event's via-agent
  record (it did by KOBE-623 design; decision 3 overrides).
- Wall probe: every page of `/v1/site/audit` plus both export formats (JSONL parsed so forbidden
  fields are named), no filter or exception; `FORBIDDEN_FIELDS` += `fromThreadId`,
  `retryOfRunId`, `suggestionId`, `toolCallId`, `approvalId`. Positive controls: the views list
  `memory.site_proposal.created` and `memory.pass.completed`.

## User-facing docs

- `docs/guide/memory.md`: Site console decisions (confirmer barred in any round, actions shown
  disabled with the reason, waits when the only curator proposed/confirmed); confirming as a Site
  curator; reminders once per step; hold note.
- `docs/guide/admin/site-admin.md` (Audit log), `admin-from-a-conversation.md` (via agent in the
  Site view). `docs/audit-log.md` (Site view of Workspace events). `/llms*.txt` are generated.

## Open questions (for Chris or the coordinator)

1. The web Site audit page has no hint that Workspace events are trimmed; a small "details stay
   with the workspace" note could follow (guide says it).
2. Should SIEM forwarding (Helm-configured, off-box) also be trimmed? Left full (the record).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `memory-site-proposals.db.test.ts` › "the Team admin who confirmed it, in any round,
  decides nothing (KOBE-666)" (approve/merge/reject/request-changes 403; `may` flags; round 2 by
  another admin); web `site-proposals.test.tsx` (own + confirmer: actions disabled with reason).
- **ac-2** `audit/site-view.test.ts` (classification, drop, Site-level unchanged);
  `site-wall-probe.db.test.ts` ac-1 (site audit pages + exports, no leak, positive controls).
- **ac-3** `memory-site-proposal-sweeps.db.test.ts` › "awaiting_team: … once, 7 days in, never
  again" and "awaiting_site: … relay" (due = confirmation + 7 d; no second reminder a week later);
  guide updated.
