import type { AuditEventDoc } from "./fragments.js";
import type { MEMORY_EVENTS } from "./memory.js";

/**
 * The docs/audit-log.md rows of the memory area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in name order.
 */
export const MEMORY_EVENT_DOCS = {
  "memory.candidate.accepted": {
    fields: "`candidateId`, `passId`, `threadId`, `scope`, `itemId`, `version`, `edited`, `batch`",
    when: "The thread's author saved a learning candidate from To review (KOBE-396); `edited`: statement, kind or scope changed first; `batch`: part of Save all mine",
  },
  "memory.candidate.added_to_project": {
    fields: "`candidateId`, `passId`, `threadId`, `projectId`, `memoryDocId`, `version`, `edited`",
    when: "The thread's author added a learning candidate under `## Learned` in the project's `MEMORY.md` from To review after approving the signed change (KOBE-398); `edited`: the statement changed first. A `memory.written` (scope `project`, `actorKind: \"user\"`) records the Notes version",
  },
  "memory.candidate.dismissed": {
    fields: "`candidateId`, `passId`, `threadId`",
    when: "The thread's author dismissed a learning candidate (KOBE-396); later passes over the thread don't offer it again",
  },
  "memory.deleted": {
    fields: "`scope`, `memoryDocId`, `version`",
    when: "A memory file was soft-deleted; versions stay (KOBE-155)",
  },
  "memory.item.archived": {
    fields: "`scope`, `itemId`, `version`",
    when: "A semantic memory item was archived; never deleted, versions stay (KOBE-377)",
  },
  "memory.item.changed_under_hold": {
    fields:
      "`itemId`, `version`, `before` and `after` (`kind`, `tagCount`, `tagsHmac` (HMAC-SHA-256 under a key derived from the server's auth secret, of the sorted, lowercased tag list as JSON), `policy`, `asOf`)",
    when: "A Site item's kind, tags, Policy flag or as-of date changed while a Site-wide legal hold is in force (KOBE-647): the item row keeps no history, so this row keeps the earlier kind, Policy flag and as-of date; tags only as a count and a keyed fingerprint, never the values",
  },
  "memory.item.created": {
    fields:
      "`scope` (user, portable, team, site), `itemId`, `kind`, `version`, `actorKind` (user, import, pass, proposal), `pinned`, `policy`",
    when: "A semantic memory item was saved, pinned or as Policy included; never the statement or tags (KOBE-377). Workspace items are team events; portable and Site items are site events, so for a person's portable preferences Site admins see the item id, kind and action only, never the statement (all `memory.item.*` events)",
  },
  "memory.item.pinned": {
    fields: "`scope`, `itemId`",
    when: "A semantic memory item was pinned (KOBE-377)",
  },
  "memory.item.restored": {
    fields: "`scope`, `itemId`, `version`",
    when: "An archived semantic memory item was restored (KOBE-377)",
  },
  "memory.item.reverted": {
    fields: "`scope`, `itemId`, `fromVersion`, `version`",
    when: "Undo: a new version copying an earlier one (KOBE-377)",
  },
  "memory.item.superseded": {
    fields: "`scope`, `itemId`, `supersededBy`",
    when: "A new item replaced this one in the same scope (KOBE-377)",
  },
  "memory.item.unpinned": {
    fields: "`scope`, `itemId`",
    when: "A semantic memory item was unpinned (KOBE-377)",
  },
  "memory.item.updated": {
    fields:
      "`scope`, `itemId`, `version`, `previousVersion`, `changed` (statement, kind, tags, as_of)",
    when: "A semantic memory item was edited (KOBE-377)",
  },
  "memory.items.exported": {
    fields: "`scope`, `format` (json, csv), `count`, `includeInactive`",
    when: "A semantic memory scope was exported; counts only (KOBE-377)",
  },
  "memory.items.imported": {
    fields: "`scope`, `format` (json, csv), `created`, `skipped`",
    when: "A semantic memory import was committed; counts only (KOBE-377)",
  },
  "memory.lint.override": {
    fields: "`scope`, `itemId`, `version`, `warnings` (codes)",
    when: "An item was saved over lint warnings (KOBE-377, SM18)",
  },
  "memory.pass.completed": {
    fields: "`passId`, `threadId`, `replied`, `stored`, `dropped`, `skillHints`, `attempts`",
    when: "A learning pass completed: candidate counts only (KOBE-393); tokens and cost are on the run's usage",
  },
  "memory.pass.failed": {
    fields:
      "`passId`, `threadId`, `reason` (budget_exhausted, learning_model_unavailable, memory_disabled, schema_rejected, timeout, model_error, cancelled, thread_busy, interrupted), `attempts`",
    when: "A learning pass failed (KOBE-393); `interrupted`: a stopped server's pass, failed by the system",
  },
  "memory.pass.started": {
    fields:
      "`passId`, `threadId`, `modelAlias`, `extractorVersion`, `entries`, `partial`, `truncated`, `summarised`",
    when: "A person started a learning pass on their thread (KOBE-393); never statements, quotes or message text",
  },
  "memory.policy.override": {
    fields: "`scope`, `itemId`, `version`, `conflicts`",
    when: "An item was saved despite contradicting Policy (KOBE-377, SM23); `conflicts` lists each Policy item (`id`, `version`; KOBE-379)",
  },
  "memory.policy.set": {
    fields: "`itemId`, `version`, `policy`",
    when: "A Site item was made Policy, or no longer Policy (KOBE-377, SM23)",
  },
  "memory.proposal.accepted": {
    fields: "`proposalId`, `proposerId`, `itemId`, `version`, `edited`",
    when: "A curator approved a Workspace proposal as a Workspace memory (KOBE-397); `edited`: Edit and approve. Never the proposer (self-approval is refused)",
  },
  "memory.proposal.created": {
    fields:
      "`proposalId`, `candidateId` (null once its conversation is gone), `edited`, `repropose`, `previousId`",
    when: "A member proposed a learning candidate to the Workspace's curators (KOBE-397); `edited`: statement or kind changed first; `repropose`: an expired proposal sent again, or one sent back for changes proposed again (`previousId`)",
  },
  "memory.proposal.dismissed": {
    fields: "`proposalId`, `proposerId`, `outcome` (dismissed, changes_requested)",
    when: "A curator turned a Workspace proposal down with a reason (KOBE-397): dismissed, or sent back to the proposer's To review for changes",
  },
  "memory.restored": {
    fields: "`scope`, `memoryDocId`, `fromVersion`, `version`",
    when: "Undo or restore: a new version copying an earlier one (KOBE-155)",
  },
  "memory.settings_changed": {
    fields: "`memoryEnabled`, `projectMemoryEnabled`",
    when: "A team admin changed the team's memory switches (KOBE-155)",
  },
  "memory.site_proposal.accepted": {
    fields:
      "`proposalId`, `fromTeamId`, `proposerId`, `outcome` (approved, merged), `itemId`, `version`, `edited`",
    when: "A Site admin or Site memory steward approved a Site proposal as a Site memory, or merged it into one as its next version (step 2); never the proposer",
  },
  "memory.site_proposal.confirmed": {
    fields: "`proposalId`, `proposerId`, `edited`, `round`",
    when: "A Team admin confirmed a Site proposal for the Site (step 1); `edited`: Edit and confirm; `round`: changes rounds so far",
  },
  "memory.site_proposal.created": {
    fields:
      "`proposalId`, `source` (candidate, item), `candidateId`, `itemId`, `confirmed`, `edited`",
    when: "A Workspace member proposed a statement to the Site (KOBE-403) from their To review candidate, or a curator from a Workspace memory; `confirmed`: a Team admin proposed it (step 1 skipped); never the statement or justification",
  },
  "memory.site_proposal.decided": {
    fields:
      "`proposalId`, `proposerId`, `outcome` (approved, merged, rejected, changes_requested, expired), `round`, `itemId`, `version`",
    when: "The proposing Workspace's record of a Site decision on its proposal (KOBE-403): the Site memory it became (approved, merged), or rejected, or sent back for changes, or `expired` after 30 days undecided (KOBE-653); recorded with the system as actor, the deciding Site curator is the actor of the paired site event; never the reason or note",
  },
  "memory.site_proposal.dismissed": {
    fields:
      "`proposalId`, `fromTeamId`, `proposerId`, `outcome` (rejected, changes_requested), `round`",
    when: "A Site curator rejected a Site proposal with a reason, or sent it back to the Workspace for changes (at most 3 rounds); never the reason or note",
  },
  "memory.site_proposal.endorsed": {
    fields: "`proposalId`, `proposerId`",
    when: "A Workspace curator (memory steward or Team admin) endorsed a Site proposal",
  },
  "memory.site_proposal.withdrawn": {
    fields:
      "`proposalId`, `proposerId`, `by` (proposer, team_admin), `fromState` (awaiting_team, awaiting_site)",
    when: "A Site proposal was withdrawn before the Site decided",
  },
  "memory.site_settings_changed": {
    fields: "`memoryEnabled`, `projectMemoryEnabled`",
    when: "A site admin changed the site-wide memory switches (KOBE-155)",
  },
  "memory.steward.granted": {
    fields: "`userId`",
    when: "A Team admin made a member a Workspace memory steward (KOBE-380)",
  },
  "memory.steward.revoked": {
    fields: "`userId`",
    when: "A Team admin took a member's Workspace memory steward grant (KOBE-380)",
  },
  "memory.suggestion.accepted": {
    fields: "`suggestionId`, `threadId`, `projectId`, `memoryDocId`, `version`, `edited`",
    when: "A project editor, owner or Team admin approved a reader's suggestion: it went under `## Learned` in the project's `MEMORY.md` through the signed change (KOBE-652). A `memory.written` (scope `project`, `actorKind: \"user\"`) records the Notes version",
  },
  "memory.suggestion.created": {
    fields: "`suggestionId`, `candidateId`, `passId`, `threadId`, `projectId`, `edited`",
    when: "A project reader suggested a learning candidate for the project's notes from To review (KOBE-652); `edited`: the statement or kind changed first. Never the statement or evidence",
  },
  "memory.suggestion.dismissed": {
    fields: "`suggestionId`, `threadId`, `projectId`, `reasonGiven`",
    when: "A project editor, owner or Team admin dismissed a reader's suggestion (KOBE-652); `reasonGiven`: they wrote a reason (never logged; the suggester sees it)",
  },
  "memory.written": {
    fields: "`scope`, `memoryDocId`, `version`, `previousVersion?`, `actorKind`, `sizeBytes`",
    when: "A memory file got a new version; never the path or content (KOBE-155)",
  },
} satisfies Record<keyof typeof MEMORY_EVENTS, AuditEventDoc>;
