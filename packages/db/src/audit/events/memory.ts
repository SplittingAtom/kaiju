import { z } from "zod";
import { SEMANTIC_MEMORY_KIND_VALUES } from "../../schema/semantic-memory.js";
import {
  count,
  embeddingModel,
  event,
  heldItemMetadata,
  id,
  memoryPromptVersion,
  modelAlias,
  semanticMemoryScope,
  version,
  type AuditEventDef,
} from "./fragments.js";
import { MEMORY_PASS_AUDIT_FAILURE_CODES } from "./vocab.js";

export const MEMORY_EVENTS = {
  // ── memory: file memory (KOBE-155, D24); ids, versions and sizes, never paths or content ──
  /** A memory file got a new version (panel edit, personal `remember`, or an approved project write). */
  "memory.written": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    version,
    previousVersion: version.optional(),
    actorKind: z.enum(["user", "agent"]),
    sizeBytes: count,
  }),
  /** Undo or restore: a new version copying an earlier one (a deleted file is revived). */
  "memory.restored": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    fromVersion: version,
    version,
  }),
  /** A memory file was deleted (soft: its versions stay and Undo can restore it). */
  "memory.deleted": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    version,
  }),
  /** A team admin changed the team's memory switches. */
  "memory.settings_changed": event("team", {
    memoryEnabled: z.boolean(),
    projectMemoryEnabled: z.boolean(),
    // KOBE-381 (absent on older rows): the v1.3 Workspace switches and learning model override.
    memoriesEnabled: z.boolean().optional(),
    workspaceMemoriesEnabled: z.boolean().optional(),
    siteMemoriesEnabled: z.boolean().optional(),
    learnEnabled: z.boolean().optional(),
    siteProposalsEnabled: z.boolean().optional(),
    learningModelAlias: modelAlias.nullable().optional(),
    /** The learning model before this save, when it changed (review L3). */
    previousLearningModelAlias: modelAlias.nullable().optional(),
  }),
  /**
   * A site admin changed the site-wide memory switches or settings. `settings` (KOBE-381) names
   * the Site memory settings whose values changed; the values themselves are in Site settings.
   */
  "memory.site_settings_changed": event("site", {
    memoryEnabled: z.boolean(),
    projectMemoryEnabled: z.boolean(),
    memoriesEnabled: z.boolean().optional(),
    portableEnabled: z.boolean().optional(),
    learnEnabled: z.boolean().optional(),
    siteProposalsEnabled: z.boolean().optional(),
    /** KOBE-410 (absent on older rows): the Learn nudge on the composer's + button. */
    learnNudgeEnabled: z.boolean().optional(),
    settings: z
      .array(z.string().regex(/^[a-z][a-z_]{0,40}$/))
      .max(20)
      .optional(),
    /** The Site learning / embedding model before and after, when it changed (review L3). */
    learningModel: z
      .strictObject({ from: modelAlias.nullable(), to: modelAlias.nullable() })
      .optional(),
    /** Since KOBE-409 a gateway model id (`kaiju-local/nomic-embed-text`); an alias before. */
    embeddingModel: z
      .strictObject({ from: embeddingModel.nullable(), to: embeddingModel.nullable() })
      .optional(),
  }),
  // ── semantic memory items (v1.3, KOBE-377, SM28): ids, scopes, kinds, versions and counts, never
  // a statement, tag or evidence. Workspace items are team events; portable and Site items site
  // events (`any`). Candidate, proposal and suggestion actions are reserved for Phase B/C
  // (`RESERVED_MEMORY_AUDIT_ACTIONS` in @kaiju/protocol) and registered by their tickets; the
  // pass actions are registered below (KOBE-393).
  /**
   * An item was saved (its first version): by a person, or from an import. Names follow the
   * brief's SM28 pattern (`memory.item.*`); the SM28 text was not available to check them.
   */
  "memory.item.created": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    kind: z.enum(SEMANTIC_MEMORY_KIND_VALUES),
    version,
    actorKind: z.enum(["user", "import", "pass", "proposal"]),
    /** Created pinned, or as Policy (Site only): no separate pin or `memory.policy.set` row. */
    pinned: z.boolean(),
    policy: z.boolean(),
  }),
  /** An item was edited: a new version (statement) and/or changed kind, tags or `as_of`. */
  "memory.item.updated": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    version,
    previousVersion: version,
    changed: z
      .array(z.enum(["statement", "kind", "tags", "as_of"]))
      .min(1)
      .max(4),
  }),
  /** Undo: a new version copying an earlier one. */
  "memory.item.reverted": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    fromVersion: version,
    version,
  }),
  /** Archived (never deleted: versions stay) or restored from the archive. */
  "memory.item.archived": event("any", { scope: semanticMemoryScope, itemId: id, version }),
  "memory.item.restored": event("any", { scope: semanticMemoryScope, itemId: id, version }),
  "memory.item.pinned": event("any", { scope: semanticMemoryScope, itemId: id }),
  "memory.item.unpinned": event("any", { scope: semanticMemoryScope, itemId: id }),
  /** A new item replaced this one (same scope). */
  "memory.item.superseded": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    supersededBy: id,
  }),
  /** An import committed: counts only. */
  "memory.items.imported": event("any", {
    scope: semanticMemoryScope,
    format: z.enum(["json", "csv"]),
    created: count,
    skipped: count,
  }),
  /** A scope was exported: counts only. */
  "memory.items.exported": event("any", {
    scope: semanticMemoryScope,
    format: z.enum(["json", "csv"]),
    count,
    includeInactive: z.boolean(),
  }),
  /**
   * A Site admin made a Site item Policy, or Policy an ordinary item (SM23); Site memory stewards
   * never do (KOBE-380).
   */
  "memory.policy.set": event("site", { itemId: id, version, policy: z.boolean() }),
  /**
   * A Site item's kind, tags, Policy flag or `as_of` changed while a Site-wide legal hold is in
   * force (KOBE-647, review L3): these live on the item row, which keeps no history, so the audit
   * row records the earlier and new values (tags as a count and a keyed fingerprint, never the values).
   */
  "memory.item.changed_under_hold": event("site", {
    itemId: id,
    version,
    before: heldItemMetadata,
    after: heldItemMetadata,
  }),
  /**
   * Saved despite contradicting Policy (SM23): the Policy items (id and version) it contradicts,
   * at most 25 (KOBE-379 review L-6).
   */
  "memory.policy.override": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    version,
    conflicts: z.array(z.strictObject({ id, version })).min(1).max(25),
  }),
  /** Saved over lint warnings (SM18): the warnings' codes. */
  "memory.lint.override": event("any", {
    scope: semanticMemoryScope,
    itemId: id,
    version,
    warnings: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
      .min(1)
      .max(20),
  }),
  // ── learning passes (KOBE-393, SM15): the actor is the person who started the pass (the
  // stale-pass sweep is the system). Ids, the model alias, the prompt version and counts only:
  // never a statement, quote, evidence, rationale or message text. Tokens and cost are the
  // gateway's `run_usage` row (`kind = memory_learn`, same run), not repeated here.
  /** A person started a learning pass on their thread: what it reads, as counts and flags. */
  "memory.pass.started": event("team", {
    passId: id,
    threadId: id,
    modelAlias,
    extractorVersion: memoryPromptVersion,
    entries: count,
    partial: z.boolean(),
    truncated: z.boolean(),
    summarised: z.boolean(),
  }),
  /** A pass completed: candidates the model replied with, stored for review, and dropped. */
  "memory.pass.completed": event("team", {
    passId: id,
    threadId: id,
    replied: count,
    stored: count,
    dropped: count,
    skillHints: count,
    attempts: count,
  }),
  /** A pass failed: its reason (`interrupted`: a stopped server's pass, failed by the sweep). */
  "memory.pass.failed": event("team", {
    passId: id,
    threadId: id,
    reason: z.enum(MEMORY_PASS_AUDIT_FAILURE_CODES),
    attempts: count,
  }),
  // ── To review (KOBE-396, SM16): the thread's author decided a pass's candidate. Ids, the scope,
  // the item and flags only: never the statement, evidence or rationale.
  /**
   * A candidate was saved as a memory (`itemId` at `version`): `edited` when the person changed
   * its statement, kind or scope first; `batch` when it was part of Save all mine.
   */
  "memory.candidate.accepted": event("team", {
    candidateId: id,
    passId: id,
    threadId: id,
    scope: z.enum(["user", "portable", "team"]),
    itemId: id,
    version,
    edited: z.boolean(),
    batch: z.boolean(),
  }),
  /** A candidate was dismissed (later passes over the thread don't offer it again). */
  "memory.candidate.dismissed": event("team", { candidateId: id, passId: id, threadId: id }),
  // ── Workspace proposals (KOBE-397, SM22): a member proposed a statement to the curators. Ids
  // and flags only: never the statement, rationale or evidence.
  /**
   * A member proposed a candidate (`candidateId`; null once its thread is gone) to the Workspace;
   * `edited` when they changed its statement or kind first; `repropose` when it is an expired
   * proposal (`previousId`) sent again or one sent back for changes proposed again.
   */
  "memory.proposal.created": event("team", {
    proposalId: id,
    candidateId: id.nullable(),
    edited: z.boolean(),
    repropose: z.boolean(),
    previousId: id.nullable(),
  }),
  /** A curator approved a proposal as Workspace memory `itemId`; `edited`: Edit and approve. */
  "memory.proposal.accepted": event("team", {
    proposalId: id,
    proposerId: id,
    itemId: id,
    version,
    edited: z.boolean(),
  }),
  /** A curator turned a proposal down with a reason: dismissed, or sent back for changes. */
  "memory.proposal.dismissed": event("team", {
    proposalId: id,
    proposerId: id,
    outcome: z.enum(["dismissed", "changes_requested"]),
  }),
  // ── Site proposals (KOBE-403, SM19/SM20/SM22): step 1 in the proposing Workspace's log (team),
  // step 2 in the site log. Ids and flags only: never the statement or justification.
  /**
   * A Workspace member proposed a statement to the Site, from their To review candidate
   * (`candidateId`) or from a Workspace memory (`itemId`, curators); `confirmed` when a Team admin
   * proposed it (step 1 skipped); `edited` when the wording or kind changed first.
   */
  "memory.site_proposal.created": event("team", {
    proposalId: id,
    source: z.enum(["candidate", "item"]),
    candidateId: id.nullable(),
    itemId: id.nullable(),
    confirmed: z.boolean(),
    edited: z.boolean(),
  }),
  /** A Team admin confirmed it for the Site (`edited`: Edit and confirm); `round` of changes. */
  "memory.site_proposal.confirmed": event("team", {
    proposalId: id,
    proposerId: id,
    edited: z.boolean(),
    round: count,
  }),
  /** A Workspace curator endorsed it (the Site sees the flag). */
  "memory.site_proposal.endorsed": event("team", { proposalId: id, proposerId: id }),
  /** Withdrawn before the Site decided, by its proposer or a Team admin. */
  "memory.site_proposal.withdrawn": event("team", {
    proposalId: id,
    proposerId: id,
    by: z.enum(["proposer", "team_admin"]),
    fromState: z.enum(["awaiting_team", "awaiting_site"]),
  }),
  /**
   * A Site curator approved it as Site memory `itemId`, or merged it into that memory as its
   * `version` (`edited`: the Site changed the wording first). Never the proposer.
   */
  "memory.site_proposal.accepted": event("site", {
    proposalId: id,
    fromTeamId: id,
    proposerId: id,
    outcome: z.enum(["approved", "merged"]),
    itemId: id,
    version,
    edited: z.boolean(),
  }),
  /**
   * The Workspace's own record of a Site decision on its proposal (team log, recorded as the
   * system; the deciding Site curator is the actor of the paired site event): approved or merged
   * as Site memory `itemId` at `version`, rejected, or sent back for changes (`round`).
   */
  "memory.site_proposal.decided": event("team", {
    proposalId: id,
    proposerId: id,
    outcome: z.enum(["approved", "merged", "rejected", "changes_requested", "expired"]),
    round: count,
    itemId: id.nullable(),
    version: version.nullable(),
  }),
  /** A Site curator rejected it with a reason, or sent it back for changes (`round` 1..3). */
  "memory.site_proposal.dismissed": event("site", {
    proposalId: id,
    fromTeamId: id,
    proposerId: id,
    outcome: z.enum(["rejected", "changes_requested"]),
    round: count,
  }),
  /**
   * A candidate went under `## Learned` in its project's `MEMORY.md` (KOBE-398) after the person
   * approved the signed change: the Notes doc at `version`; `edited` when the statement changed
   * first.
   */
  "memory.candidate.added_to_project": event("team", {
    candidateId: id,
    passId: id,
    threadId: id,
    projectId: id,
    memoryDocId: id,
    version,
    edited: z.boolean(),
  }),
  // ── Readers' suggestions to a project's Notes (KOBE-652, SM7/Q2): ids and flags only, never the
  // statement, evidence or the dismissal reason.
  /** A project reader suggested a candidate for the project's notes (`edited`: changed first). */
  "memory.suggestion.created": event("team", {
    suggestionId: id,
    candidateId: id,
    passId: id,
    threadId: id,
    projectId: id,
    edited: z.boolean(),
  }),
  /**
   * A project editor, owner or Team admin approved a suggestion: it went under `## Learned` in the
   * project's `MEMORY.md` (the Notes doc at `version`) through the signed change.
   */
  "memory.suggestion.accepted": event("team", {
    suggestionId: id,
    threadId: id,
    projectId: id,
    memoryDocId: id,
    version,
    edited: z.boolean(),
  }),
  /** A suggestion was dismissed; `reasonGiven` when the decider wrote why. */
  "memory.suggestion.dismissed": event("team", {
    suggestionId: id,
    threadId: id,
    projectId: id,
    reasonGiven: z.boolean(),
  }),
  /** A Team admin made a member a Workspace memory steward, or took it back (KOBE-380). */
  "memory.steward.granted": event("team", { userId: id }),
  "memory.steward.revoked": event("team", { userId: id }),
} as const satisfies Record<string, AuditEventDef>;
