import {
  MEMORY_PROPOSAL_STATE_VALUES,
  MEMORY_SUGGESTION_STATE_VALUES,
  SITE_MEMORY_PROPOSAL_STATE_VALUES,
} from "@kobe/db";
import {
  MEMORY_CANDIDATE_OPERATIONS,
  MEMORY_CANDIDATE_SOURCES,
  MEMORY_SCOPES,
  SEMANTIC_MEMORY_KINDS,
  SEMANTIC_MEMORY_SCOPES,
  memoryDocDetailSchema,
  memoryListResponseSchema,
  memoryPutRequestSchema,
  memoryRestoreRequestSchema,
} from "@kobe/protocol";
import { z } from "zod";
import { LEARN_UNAVAILABLE_REASONS } from "../../../memory/learning-model.js";
import {
  approveSchema as approveProposalSchema,
  reasonSchema,
} from "../../../memory/proposals/decide.js";
import { proposeSchema } from "../../../memory/proposals/propose.js";
import {
  approveSiteProposalSchema,
  confirmSiteProposalSchema,
  mergeSiteProposalSchema,
  proposeSiteFromCandidateSchema,
  proposeSiteFromItemSchema,
  rejectSiteProposalSchema,
  requestSiteChangesSchema,
  siteProposalListQuerySchema,
} from "../../../memory/proposals/site/schemas.js";
import { candidateIdsSchema, saveCandidateSchema } from "../../../memory/review/decide.js";
import { notesAddSchema, notesPreviewSchema } from "../../../memory/review/project-notes.js";
import {
  sitePutSchema,
  siteMemoryWireSchema,
  workspaceMemoryWireSchema,
  workspacePutSchema,
} from "../../../memory/settings-wire.js";
import {
  approvePreviewSchema,
  approveSchema as approveSuggestionSchema,
  dismissSchema as dismissSuggestionSchema,
} from "../../../memory/suggestions/decide.js";
import { suggestSchema } from "../../../memory/suggestions/suggest.js";
import { siteItemsQuery, workspaceItemsQuery } from "../../../routes/memory-quality.js";
import { threadQuery } from "../../../routes/memory-review.js";
import { listQuery as suggestionListQuery } from "../../../routes/memory-suggestions.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import {
  arr,
  bool,
  dateTime,
  int,
  nullable,
  num,
  obj,
  oneOfStrings,
  refTo,
  str,
  uuid,
} from "../json.js";

/**
 * Request and response schemas of the memory catalog areas (KOBE-771): Memory (Notes docs,
 * settings, To review, Workspace proposals, Site proposals from the Workspace, suggestions,
 * quality, vectors) and Site: memory. Bodies are the zod schemas the routes validate with; most
 * answers are built by the memory services without a schema, so they are `untyped(...)` with the
 * fields read from `memory/review`, `memory/proposals`, `memory/suggestions` and `memory/quality`.
 * A saved memory item is the hand-written `SemanticMemoryItemDetail` component.
 */

type JsonSchema = Record<string, unknown>;

const constBool = (value: boolean): JsonSchema => ({ type: "boolean", const: value });
const counts: JsonSchema = { type: "object", additionalProperties: int };
const itemDetail = refTo("SemanticMemoryItemDetail");
const kind = oneOfStrings(...SEMANTIC_MEMORY_KINDS);
const person = obj({ id: uuid, name: str });
const evidence = arr(obj({ entry_id: str, quote: str }));
const related = obj({ id: uuid, version: int, statement: str });
const issue = obj({ code: str, message: str });

// ---- Notes docs and settings -------------------------------------------------------------

const DocDetail = named("MemoryDocDetail", memoryDocDetailSchema);
const projectIdQuery = {
  project_id: { type: "string", format: "uuid", description: "Required for `scope=project`." },
};

const SettingsLevel = named(
  "MemorySettingsLevel",
  z.union([workspaceMemoryWireSchema, siteMemoryWireSchema]),
);
const effectiveSettings = obj({
  memory_enabled: bool,
  project_memory_enabled: bool,
  memories_enabled: bool,
  scopes: obj(Object.fromEntries(SEMANTIC_MEMORY_SCOPES.map((s) => [s, bool]))),
  policy: bool,
  site_proposals_enabled: bool,
  learn: {
    anyOf: [
      obj({ available: constBool(true), alias: str, source: oneOfStrings("site", "team") }),
      obj({
        available: constBool(false),
        reason: oneOfStrings(...LEARN_UNAVAILABLE_REASONS),
        message: str,
      }),
    ],
  },
});
const SettingsRead = untyped("MemorySettingsRead", {
  anyOf: [refTo("MemorySettingsLevel"), effectiveSettings],
  description:
    "`level=team`: the Workspace switches; `level=site`: the Site switches and settings; " +
    "`level=effective`: what applies to the active Workspace now.",
});
const levelQuery = (values: readonly string[]) => ({
  level: { type: "string", enum: [...values], description: "Which switch level." },
});

const buildJob = obj({
  state: oneOfStrings("running", "done", "stopped"),
  model: str,
  startedBy: uuid,
  teamId: nullable(uuid),
  startedAt: dateTime,
  finishedAt: nullable(dateTime),
  embedded: int,
  stopReason: nullable(str),
});

// ---- To review ---------------------------------------------------------------------------

const reviewCard = obj({
  id: uuid,
  pass_id: uuid,
  statement: str,
  kind,
  destination: oneOfStrings("user", "portable", "team", "project_notes"),
  scope: oneOfStrings("user", "portable", "team"),
  allowed_scopes: arr(oneOfStrings("user", "portable", "team")),
  scope_locked: bool,
  save_all_mine: bool,
  project_specific: bool,
  source: oneOfStrings(...MEMORY_CANDIDATE_SOURCES),
  operation: oneOfStrings(...MEMORY_CANDIDATE_OPERATIONS),
  target: nullable(related),
  target_changed: bool,
  confidence: num,
  rationale: str,
  evidence,
  warnings: arr(str),
  policy_conflicts: arr(related),
  near_duplicates: arr(related),
  expires_at: dateTime,
  created_at: dateTime,
});
const ReviewList = untyped(
  "MemoryReviewList",
  obj({
    thread_id: uuid,
    can_curate_workspace: bool,
    candidates: arr(reviewCard),
    skill_hints: arr(obj({ title: str, summary: str })),
    project_notes: nullable(
      obj({
        project_id: uuid,
        access: oneOfStrings("read", "write"),
        available: bool,
        reason: nullable(str),
      }),
    ),
  }),
);
const savedCandidate = obj({ candidate_id: uuid, item: itemDetail });
const Proposed = untyped(
  "MemoryProposalCreated",
  obj({ proposal_id: uuid, candidate_id: uuid, expires_at: dateTime }),
);
const notesPreviewFields = {
  project_id: uuid,
  path: str,
  section: oneOfStrings("Learned"),
  base_version: int,
  line: str,
  warnings: arr(issue),
  approval: str,
};
const notesAddedFields = { project_id: uuid, memory_doc_id: uuid, version: int, line: str };

// ---- Workspace proposals -----------------------------------------------------------------

const proposalBase = {
  id: uuid,
  statement: str,
  kind,
  rationale: nullable(str),
  state: oneOfStrings(...MEMORY_PROPOSAL_STATE_VALUES),
  proposer: person,
  thread_id: nullable(uuid),
  evidence,
  reason: nullable(str),
  decided_at: nullable(dateTime),
  expires_at: dateTime,
  created_at: dateTime,
};

const ProposalReason = named("MemoryProposalReasonBody", reasonSchema);
const TurnedDown = untyped(
  "MemoryProposalTurnedDown",
  obj({ proposal_id: uuid, back_in_review: bool }),
);

// ---- Site proposals ----------------------------------------------------------------------

const siteProposalCommon = {
  id: uuid,
  statement: str,
  kind,
  justification: str,
  endorsed: bool,
  state: oneOfStrings(...SITE_MEMORY_PROPOSAL_STATE_VALUES),
  rounds: int,
  proposer: person,
  confirmed_by: nullable(person),
  confirmed_at: nullable(dateTime),
  reason: nullable(str),
  changes_note: nullable(str),
  decided_at: nullable(dateTime),
  merged_into: nullable(uuid),
  expires_at: dateTime,
  created_at: dateTime,
  updated_at: dateTime,
};
const workspaceProposalView = obj({
  ...siteProposalCommon,
  may: obj({ confirm: bool, endorse: bool, withdraw: bool }),
});
const siteProposalView = obj({
  ...siteProposalCommon,
  from_workspace: obj({ id: uuid, name: str }),
  decided_by: nullable(person),
  may: obj({ decide: bool, decide_blocked: nullable(oneOfStrings("own_proposal", "confirmed")) }),
});
const WorkspaceProposal = untyped(
  "WorkspaceSiteProposal",
  obj({ proposal: workspaceProposalView }),
);
const SiteProposed = untyped(
  "WorkspaceSiteProposalChecked",
  obj({
    proposal: workspaceProposalView,
    checks: obj({ warnings: arr(str), policy_conflicts: arr(obj({ id: uuid, version: int })) }),
  }),
);
const SiteProposal = untyped("SiteMemoryProposal", obj({ proposal: siteProposalView }));
const SiteDecision = untyped(
  "SiteMemoryProposalDecision",
  obj({ proposal: siteProposalView, item: itemDetail }),
);

// ---- Suggestions -------------------------------------------------------------------------

const suggestionCard = obj({
  id: uuid,
  project_id: uuid,
  project_name: str,
  thread_id: uuid,
  statement: str,
  kind,
  evidence,
  suggested_by: person,
  state: oneOfStrings(...MEMORY_SUGGESTION_STATE_VALUES),
  reason: nullable(str),
  created_at: dateTime,
  expires_at: dateTime,
  decided_at: nullable(dateTime),
});

// ---- Quality -----------------------------------------------------------------------------

const ItemSignals = untyped(
  "MemoryItemSignals",
  obj({
    scope: oneOfStrings("user", "team", "site"),
    thresholds: obj({ check_min_runs: int, check_down_ratio: num, unused_after_days: int }),
    counts: obj({ all: int, check_this: int, unused: int }),
    items: arr(
      obj({
        id: uuid,
        statement: str,
        kind,
        pinned: bool,
        policy: bool,
        runs: int,
        down_runs: int,
        last_received_at: nullable(dateTime),
        flags: obj({ check_this: bool, unused: bool }),
      }),
    ),
  }),
);
const QueueHealth = untyped(
  "MemoryQueueHealth",
  obj({
    window_days: int,
    queues: arr(
      obj({
        queue: oneOfStrings("workspace_proposals", "project_suggestions", "site_proposals"),
        pending: int,
        oldest_pending_at: nullable(dateTime),
        decided: int,
        median_decision_seconds: nullable(int),
      }),
    ),
  }),
);
const passSignals = {
  passes: int,
  failed: int,
  shown: int,
  saved: int,
  proposed: int,
  suggested: int,
  dismissed: int,
  expired: int,
  open: int,
  edited_before_save: int,
};

export const memoryDetails: Readonly<Record<string, CatalogDetail>> = {
  // Notes docs (`routes/memory/`): storage failures are 503.
  "get /v1/memory": {
    query: {
      scope: { type: "string", enum: [...MEMORY_SCOPES], description: "Whose docs." },
      ...projectIdQuery,
    },
    requiredQuery: ["scope"],
    response: named("MemoryDocList", memoryListResponseSchema),
    errors: ["404", "409", "503"],
  },
  "put /v1/memory": {
    query: projectIdQuery,
    body: named("MemoryPutBody", memoryPutRequestSchema),
    response: DocDetail,
    responseDescription: "The doc as written, with its versions.",
    errors: ["404", "409", "413", "422", "503"],
  },
  "delete /v1/memory/{id}": { status: 204, errors: ["404", "409", "503"] },
  "get /v1/memory/{id}": { response: DocDetail, errors: ["404", "409", "503"] },
  "post /v1/memory/{id}/restore": {
    body: named("MemoryRestoreBody", memoryRestoreRequestSchema),
    response: DocDetail,
    errors: ["404", "409", "503"],
  },

  // Workspace proposals (`routes/memory-proposals.ts`).
  "get /v1/memory/proposals": {
    response: untyped(
      "MemoryProposalQueue",
      obj({
        proposals: arr(
          obj({
            ...proposalBase,
            warnings: arr(str),
            near_duplicates: arr(related),
            policy_conflicts: arr(related),
          }),
        ),
      }),
    ),
    errors: ["409"],
  },
  "post /v1/memory/proposals/{id}/approve": {
    body: named("ApproveMemoryProposalBody", approveProposalSchema),
    bodyOptional: true,
    response: untyped("MemoryProposalApproved", obj({ proposal_id: uuid, item: itemDetail })),
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/proposals/{id}/dismiss": {
    body: ProposalReason,
    response: TurnedDown,
    errors: ["404", "409"],
  },
  "post /v1/memory/proposals/{id}/repropose": {
    body: null,
    status: 201,
    response: Proposed,
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/proposals/{id}/request-changes": {
    body: ProposalReason,
    response: TurnedDown,
    errors: ["404", "409"],
  },
  "get /v1/memory/proposals/mine": {
    response: untyped(
      "MemoryProposalsMine",
      obj({
        proposals: arr(obj({ ...proposalBase, back_in_review: bool, may_repropose: bool })),
      }),
    ),
    errors: ["409"],
  },

  // Quality, Workspace side (`routes/memory-quality.ts`).
  "get /v1/memory/quality/items": {
    query: workspaceItemsQuery,
    response: ItemSignals,
    errors: ["409"],
  },
  "get /v1/memory/quality/passes": {
    response: untyped("MemoryPassSignals", obj({ window_days: int, signals: obj(passSignals) })),
    errors: ["409"],
  },
  "get /v1/memory/quality/queues": { response: QueueHealth, errors: ["409"] },

  // To review (`routes/memory-review.ts`).
  "get /v1/memory/review": {
    query: threadQuery,
    response: ReviewList,
    errors: ["404", "409"],
  },
  "post /v1/memory/review/candidates/{id}/dismiss": {
    body: null,
    response: untyped("MemoryCandidateDismissed", obj({ candidate_id: uuid })),
    errors: ["404", "409"],
  },
  "post /v1/memory/review/candidates/{id}/project-notes": {
    body: named("MemoryCandidateNotesAddBody", notesAddSchema),
    response: untyped(
      "MemoryCandidateNotesAdded",
      obj({ candidate_id: uuid, ...notesAddedFields }),
    ),
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/memory/review/candidates/{id}/project-notes/preview": {
    body: named("MemoryCandidateNotesPreviewBody", notesPreviewSchema),
    bodyOptional: true,
    response: untyped(
      "MemoryCandidateNotesPreview",
      obj({ candidate_id: uuid, ...notesPreviewFields }),
    ),
    responseDescription: "The exact change and its signed `approval` to send back.",
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/memory/review/candidates/{id}/propose": {
    body: named("ProposeMemoryCandidateBody", proposeSchema),
    bodyOptional: true,
    status: 201,
    response: Proposed,
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/review/candidates/{id}/save": {
    body: named("SaveMemoryCandidateBody", saveCandidateSchema),
    bodyOptional: true,
    response: untyped("MemoryCandidateSaved", savedCandidate),
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/review/candidates/{id}/suggest": {
    body: named("SuggestMemoryCandidateBody", suggestSchema),
    bodyOptional: true,
    response: untyped(
      "MemoryCandidateSuggested",
      obj({
        suggestion_id: uuid,
        candidate_id: uuid,
        project_id: uuid,
        state: oneOfStrings("pending"),
        expires_at: dateTime,
        evidence,
      }),
    ),
    errors: ["404", "409"],
  },
  "post /v1/memory/review/save-all": {
    body: named("MemoryCandidateIdsBody", candidateIdsSchema),
    response: untyped("MemoryCandidatesSaved", obj({ saved: arr(savedCandidate) })),
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/review/seen": {
    body: named("MemoryReviewSeenBody", threadQuery.strict()),
    response: untyped("MemoryReviewSeen", obj({ read: int })),
    responseDescription: "How many bell notices were marked read.",
    errors: ["409"],
  },
  "post /v1/memory/review/undo": {
    body: named("MemoryCandidateIdsBody", candidateIdsSchema),
    response: untyped("MemoryCandidatesReopened", obj({ reopened: arr(uuid) })),
    errors: ["404", "409"],
  },

  // Settings (`routes/memory-settings.ts`).
  "get /v1/memory/settings": {
    query: levelQuery(["team", "site", "effective"]),
    requiredQuery: ["level"],
    response: SettingsRead,
    errors: ["409"],
  },
  "put /v1/memory/settings": {
    query: levelQuery(["team", "site"]),
    requiredQuery: ["level"],
    body: named("MemorySettingsBody", z.union([workspacePutSchema, sitePutSchema])),
    response: SettingsLevel,
    responseDescription: "The level's settings after the change.",
    errors: ["409"],
  },

  // Site proposals, Workspace side (`routes/memory-site-proposals.ts`).
  "get /v1/memory/site-proposals": {
    query: siteProposalListQuerySchema.omit({ from_team_id: true }),
    response: untyped(
      "WorkspaceSiteProposalList",
      obj({ proposals: arr(workspaceProposalView), counts }),
    ),
    responseDescription: "The proposals and how many there are per state.",
    errors: ["409"],
  },
  "post /v1/memory/site-proposals": {
    body: named("ProposeSiteMemoryFromItemBody", proposeSiteFromItemSchema),
    status: 201,
    response: SiteProposed,
    errors: ["404", "409", "422"],
  },
  "get /v1/memory/site-proposals/{id}": { response: WorkspaceProposal, errors: ["404", "409"] },
  "post /v1/memory/site-proposals/{id}/confirm": {
    body: named("ConfirmSiteMemoryProposalBody", confirmSiteProposalSchema),
    bodyOptional: true,
    response: SiteProposed,
    errors: ["404", "409", "422"],
  },
  "post /v1/memory/site-proposals/{id}/endorse": {
    body: null,
    response: WorkspaceProposal,
    errors: ["404", "409"],
  },
  "post /v1/memory/site-proposals/{id}/withdraw": {
    body: null,
    response: WorkspaceProposal,
    errors: ["404", "409"],
  },
  "post /v1/memory/site-proposals/candidates/{candidateId}": {
    body: named("ProposeSiteMemoryFromCandidateBody", proposeSiteFromCandidateSchema),
    status: 201,
    response: SiteProposed,
    errors: ["404", "409", "422"],
  },

  // Suggestions (`routes/memory-suggestions.ts`).
  "get /v1/memory/suggestions": {
    query: suggestionListQuery,
    response: untyped(
      "MemorySuggestionList",
      obj({
        project_id: nullable(uuid),
        can_decide: bool,
        suggestions: arr(suggestionCard),
        mine: arr(suggestionCard),
      }),
    ),
    errors: ["404", "409"],
  },
  "post /v1/memory/suggestions/{id}/approve": {
    body: named("ApproveMemorySuggestionBody", approveSuggestionSchema),
    response: untyped(
      "MemorySuggestionApproved",
      obj({ suggestion_id: uuid, ...notesAddedFields }),
    ),
    errors: ["404", "409", "422", "503"],
  },
  "post /v1/memory/suggestions/{id}/dismiss": {
    body: named("DismissMemorySuggestionBody", dismissSuggestionSchema),
    bodyOptional: true,
    response: untyped(
      "MemorySuggestionDismissed",
      obj({ suggestion_id: uuid, state: oneOfStrings("dismissed") }),
    ),
    errors: ["404", "409"],
  },
  "post /v1/memory/suggestions/{id}/preview": {
    body: named("PreviewMemorySuggestionBody", approvePreviewSchema),
    bodyOptional: true,
    response: untyped(
      "MemorySuggestionPreview",
      obj({ suggestion_id: uuid, ...notesPreviewFields }),
    ),
    responseDescription: "The exact change and its signed `approval` to send back.",
    errors: ["404", "409", "422", "503"],
  },

  // Vectors (`routes/memory-vectors.ts`, Site admins).
  "get /v1/memory/vectors": {
    response: untyped(
      "MemoryVectorStatus",
      obj({
        pgvector: oneOfStrings("enabled", "available", "missing"),
        columns: bool,
        model: nullable(str),
        model_state: oneOfStrings("ok", "no_model", "provider_missing"),
        server_calls: bool,
        local_model: nullable(str),
        providers: arr(str),
        coverage: nullable(obj({ embedded: int, total: int })),
        job: nullable(buildJob),
        running_elsewhere: bool,
      }),
    ),
  },
  "post /v1/memory/vectors/build": {
    body: null,
    status: 202,
    response: untyped("MemoryVectorBuild", obj({ job: buildJob })),
    responseDescription: "The build started.",
    errors: ["409"],
  },
};

export const siteMemoryDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/memory/proposals": {
    query: siteProposalListQuerySchema,
    response: untyped("SiteMemoryProposalList", obj({ proposals: arr(siteProposalView), counts })),
    responseDescription: "The proposals and how many there are per state.",
  },
  "get /v1/site/memory/proposals/{id}": {
    response: untyped(
      "SiteMemoryProposalChecked",
      obj({
        proposal: siteProposalView,
        checks: obj({
          secret: bool,
          warnings: arr(str),
          near_duplicates: arr(obj({ id: uuid, version: int, statement: str, policy: bool })),
          policy_conflicts: arr(related),
        }),
      }),
    ),
    errors: ["404"],
  },
  "post /v1/site/memory/proposals/{id}/approve": {
    body: named("ApproveSiteMemoryProposalBody", approveSiteProposalSchema),
    bodyOptional: true,
    response: SiteDecision,
    errors: ["404", "409", "422"],
  },
  "post /v1/site/memory/proposals/{id}/merge": {
    body: named("MergeSiteMemoryProposalBody", mergeSiteProposalSchema),
    response: SiteDecision,
    errors: ["404", "409", "422"],
  },
  "post /v1/site/memory/proposals/{id}/reject": {
    body: named("RejectSiteMemoryProposalBody", rejectSiteProposalSchema),
    response: SiteProposal,
    errors: ["404", "409"],
  },
  "post /v1/site/memory/proposals/{id}/request-changes": {
    body: named("RequestSiteMemoryChangesBody", requestSiteChangesSchema),
    response: SiteProposal,
    errors: ["404", "409"],
  },
  "get /v1/site/memory/proposals/items/{itemId}/provenance": {
    response: untyped(
      "SiteMemoryItemProvenance",
      obj({
        set_by: oneOfStrings("workspace", "site"),
        "from_proposals?": arr(
          obj({
            version: int,
            proposal_id: uuid,
            from_workspace: nullable(obj({ id: uuid, name: str })),
          }),
        ),
      }),
    ),
    responseDescription: 'Site curators get `from_proposals`; everyone else `{set_by: "site"}`.',
    errors: ["404"],
  },
  "get /v1/site/memory/quality/items": { query: siteItemsQuery, response: ItemSignals },
  "get /v1/site/memory/quality/passes": {
    response: untyped(
      "SiteMemoryPassSignals",
      obj({
        window_days: int,
        totals: obj(passSignals),
        workspaces: arr(obj({ team_id: uuid, name: str, ...passSignals })),
      }),
    ),
  },
  "get /v1/site/memory/quality/queues": { response: QueueHealth },
};
