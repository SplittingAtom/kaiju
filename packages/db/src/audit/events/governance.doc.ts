import type { AuditEventDoc } from "./fragments.js";
import type { GOVERNANCE_EVENTS } from "./governance.js";

/**
 * The docs/audit-log.md rows of the governance area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const GOVERNANCE_EVENT_DOCS = {
  "audit.chain.upgraded": {
    fields: "`throughSeq`, `rows`, `seal`",
    when: "Written once by the server after the chain v2 upgrade, on a site that had audit rows: the seal over every v1 row (system)",
  },
  "audit.exported": {
    fields: "`format` (csv, jsonl), `from?`, `to?`, `rows`, `complete`",
    when: "An admin downloaded the log (KOBE-19). Site admins: site scope; team admins: recorded in their team. `complete` false when the download broke off",
  },
  "audit.pii_erased": {
    fields: "`rows`, `olderThanHours`",
    when: "The sweep erased the IP and user agent of rows past the retention period (system; counts only, nothing about holds)",
  },
  "governance.break_glass.approved": {
    fields:
      "as requested, but `expiresAt`, `selfApproved` and `teamAdmins` (0 = no team admin could be told) instead of `durationMinutes`",
    when: "A second site admin approved (or a single-admin site self-approved, flagged)",
  },
  "governance.break_glass.denied": {
    fields: "`grantId`, `recipients`",
    when: "Another site admin denied the request",
  },
  "governance.break_glass.expired": {
    fields: "`grantId`, `wasActive`, `recipients`, `teamAdmins?`",
    when: "The window ended, or the request lapsed undecided after 24 h (system)",
  },
  "governance.break_glass.notification_failed": {
    fields: "`grantId`, `recipientUserId`, `event`, `attempts`",
    when: "A queued break-glass email gave up after its retries (system)",
  },
  "governance.break_glass.read": {
    fields: "`grantId`, `object` (thread_list, thread, thread_entries), `threadId?`",
    when: "**Every** read under a grant, in the read's own transaction (actor: the requesting admin). Under legal hold no event names the subject or thread",
  },
  "governance.break_glass.requested": {
    fields:
      "`grantId`, `scope` (team, user, thread), `subjectUserId?`, `threadId?`, `legalHold`, `durationMinutes`, `recipients`",
    when: "A site admin requested break-glass access to the team (D10; the reason stays in the grant)",
  },
  "governance.break_glass.revoked": {
    fields: "`grantId`, `wasActive`, `recipients`, `teamAdmins?`",
    when: "Withdrawn while pending, or revoked during the window",
  },
  "governance.legal_hold.denied": {
    fields: "`holdId`",
    when: "Another site admin turned the request down",
  },
  "governance.legal_hold.placed": {
    fields: "as requested, plus `selfApproved`",
    when: "A second site admin placed it (a single-admin site self-approved, flagged): purges of the data are suspended",
  },
  "governance.legal_hold.release_denied": {
    fields: "`holdId`",
    when: "Another site admin turned the release down",
  },
  "governance.legal_hold.release_requested": {
    fields: "`holdId`",
    when: "A site admin asked to release an active hold (it stays in force)",
  },
  "governance.legal_hold.release_withdrawn": {
    fields: "`holdId`",
    when: "The release requester withdrew it",
  },
  "governance.legal_hold.released": {
    fields: "as requested, plus `selfApproved`",
    when: "A second site admin approved the release (single-admin site: flagged): purges may resume",
  },
  "governance.legal_hold.requested": {
    fields: "`holdId`",
    when: "A site admin asked for a legal hold on a team or on one user's data in it (D18; the id only, see below)",
  },
  "governance.legal_hold.withdrawn": {
    fields: "`holdId`",
    when: "The requester withdrew it while pending",
  },
  "governance.site_break_glass.approved": {
    fields:
      "as requested, but `expiresAt`, `selfApproved` and `teamAdmins` instead of `durationMinutes`",
    when: "A second site admin approved (or a single-admin site self-approved, flagged)",
  },
  "governance.site_break_glass.denied": {
    fields: "`grantId`, `recipients`",
    when: "Another site admin denied the request",
  },
  "governance.site_break_glass.expired": {
    fields: "`grantId`, `wasActive`, `recipients`, `teamAdmins?`",
    when: "The window ended, or the request lapsed undecided after 24 h (system)",
  },
  "governance.site_break_glass.notification_failed": {
    fields: "`grantId`, `recipientUserId`, `event`, `attempts`",
    when: "A queued Site break-glass email gave up after its retries (system)",
  },
  "governance.site_break_glass.read": {
    fields:
      "`grantId`, `object` (portable_items, portable_item), `itemId?`, `subjectUserId?`, `workspaces?` (Site row)",
    when: "**Every** read of the person's portable memories: one row in the Site log and one in each Workspace the person belongs to, in the read's own transaction. Under legal hold no row names the person, and Workspace rows leave out the item",
  },
  "governance.site_break_glass.requested": {
    fields:
      "`grantId`, `subjectUserId?` (left out under legal hold), `legalHold`, `durationMinutes`, `recipients`",
    when: "A site admin asked to read one person's portable memories (KOBE-648, SM28; the reason stays in the grant)",
  },
  "governance.site_break_glass.revoked": {
    fields: "`grantId`, `wasActive`, `recipients`, `teamAdmins?`",
    when: "Withdrawn while pending, or revoked during the window",
  },
  "governance.site_legal_hold.denied": {
    fields: "`holdId`",
    when: "Another site admin turned the request down",
  },
  "governance.site_legal_hold.placed": {
    fields: "as requested, plus `selfApproved`",
    when: "A second site admin placed it (single-admin site: flagged): every delete of Site memory items and versions is refused",
  },
  "governance.site_legal_hold.release_denied": {
    fields: "`holdId`",
    when: "Another site admin turned the release down",
  },
  "governance.site_legal_hold.release_requested": {
    fields: "`holdId`",
    when: "A site admin asked to release an active Site-wide hold (it stays in force)",
  },
  "governance.site_legal_hold.release_withdrawn": {
    fields: "`holdId`",
    when: "The release requester withdrew it",
  },
  "governance.site_legal_hold.released": {
    fields: "as requested, plus `selfApproved`",
    when: "A second site admin approved the release (single-admin site: flagged): Site memory purges and version pruning resume",
  },
  "governance.site_legal_hold.requested": {
    fields: "`holdId`",
    when: "A site admin asked for a Site-wide legal hold on the Site's own memory (KOBE-647, SM28; the id only)",
  },
  "governance.site_legal_hold.withdrawn": {
    fields: "`holdId`",
    when: "The requester withdrew it while pending",
  },
  "retention.blobs_deleted": {
    fields: "`blobs`, `kept`",
    when: "Object-store keys released by purges deleted (`kept`: still referenced elsewhere or outside the team's keys; system, KOBE-18)",
  },
  "retention.compacted": {
    fields: "`runs`, `events`",
    when: "Live events of runs that ended 7+ days ago folded away; the entries keep the conversation (system, D18, KOBE-18)",
  },
  "retention.eval_cases_purged": {
    fields: "`reason` (retention, hold_released), `rows`",
    when: "Shared eval cases past the team's retention window, or copies kept for a released hold, purged (system, count only, KOBE-276); a departed member's cases go with offboarding, not audited on their own",
  },
  "retention.feedback_history_purged": {
    fields: "`rows`",
    when: "Answer ratings kept for a legal hold (changed or cleared while held) purged once no hold covers the thread's owner or the rater (system, count only, KOBE-275)",
  },
  "retention.maximum.change_cancelled": {
    fields: "`maximum` (the cancelled one), `kept`",
    when: "A site admin cancelled a pending lowering of the maximum (KOBE-18)",
  },
  "retention.maximum.changed": {
    fields: "`maximum` (30d, 90d, 1y, forever), `previous`, `effectiveAt?`",
    when: "A site admin changed the longest period any team may keep threads (D6, KOBE-18); `effectiveAt` when it is lowered (7-day grace)",
  },
  "retention.memory_learning_purged": {
    fields:
      "`reason` (retention, offboarding), counts `candidatesExpired`, `proposalsExpired`, `suggestionsExpired`, `passes`, `candidates`, `dismissals`, `watermarks`, `proposals`, `suggestions`, `userId?`",
    when: "Learn from this chat records: candidates expired (14 d), proposals and project suggestions expired (30 d), passes purged past the window with the decided proposals and suggestions made from them (`proposals`, `suggestions`; pass-less decided ones by decision date, KOBE-671), or a departed member's records 30 days on (always recorded); counts only, held people skipped (KOBE-651)",
  },
  "retention.memory_purged": {
    fields:
      "`reason` (retention, offboarding), `docs`, `versions`, `blobs`, `userId?` (offboarding)",
    when: "Memory purged by the retention job (superseded versions and files deleted longer than the window ago) or the offboarding sweep (a departed member's personal memory); system, counts only, held memory never included (KOBE-188, D24)",
  },
  "retention.policy.change_cancelled": {
    fields: "`period` (the cancelled one), `kept`",
    when: "A team admin cancelled the team's pending shortening during its grace period (KOBE-18)",
  },
  "retention.policy.changed": {
    fields: "`period` (30d, 90d, 1y, forever), `previous`, `effectiveAt?`",
    when: "A team admin changed the team's retention period (D18, KOBE-18); `effectiveAt` when it shortens: it applies then, after the 7-day grace period",
  },
  "retention.purged": {
    fields:
      "`reason` (retention, trash, offboarding), `threads`, `entries`, `runs`, `events`, `blobs`, `appResults?`, `userId?` (offboarding)",
    when: "A batch of threads purged by the retention job (system; counts only; held data is never in a batch, KOBE-18)",
  },
  "retention.semantic_memory_purged": {
    fields:
      "`reason` (retention, offboarding), `items`, `versions`, `scrubbed`, `userId?` (offboarding)",
    when: "Workspace semantic memories purged: archived/superseded memories and old versions past the window, evidence dropped when its conversation was purged (`scrubbed`), or a departed member's personal memories 30 days after they left (always recorded); system, counts only, held memories never included (KOBE-386)",
  },
  "retention.shortening_notified": {
    fields: "`period`, `effectiveAt`, `threads`, `recipients`",
    when: "The team's admins were emailed about an upcoming shortening (system; how many conversations it would delete, never titles; KOBE-18)",
  },
  "retention.site_memory_purged": {
    fields:
      "`lane` (site, portable), `reason` (retention, offboarding), `items`, `versions`, `kept`, `userId?` (offboarding)",
    when: "Site or portable memories purged: archived/superseded memories and old versions past the Site window (system), or a deactivated person's portable memories purged by a site admin (a row per batch, also when none). `kept`: used by a run in a held workspace or a supersede cycle; counts only (KOBE-386)",
  },
  "retention.skill_drafts_purged": {
    fields: "`reason` (retention, offboarding, hold_released), `rows`",
    when: "Workbench drafts purged past the window, 30 days after their author left, or a hold's released copies (system, counts, KOBE-320)",
  },
  "retention.table_swept": {
    fields: "`table` (events, notifications, run_usage, orbit_evals), `rows`",
    when: "Rows of a table that would otherwise grow for ever deleted past the period set in the chart (`retention.sweeps`): processed events, read notifications, model usage rows, finished agent evals; held members kept (system, a row per batch, count only, KOBE-741)",
  },
  "retention.workspace_hold_history_purged": {
    fields: "`rows`",
    when: "Old paths of moved workspace files kept for a legal hold, purged by the retention pass once no hold covers the member (system; KOBE-304; count only)",
  },
} satisfies Record<keyof typeof GOVERNANCE_EVENTS, AuditEventDoc>;
