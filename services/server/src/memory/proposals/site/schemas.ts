import { z } from "zod";
import {
  semanticMemoryKindSchema,
  semanticMemoryOverridesSchema,
  semanticMemoryStatementSchema,
} from "@kaiju/protocol";
import {
  SITE_MEMORY_PROPOSAL_STATE_VALUES,
  SITE_MEMORY_PROPOSAL_TEXT_MAX,
  SITE_MEMORY_PROPOSAL_ROUNDS_MAX,
} from "@kaiju/db";
import { SITE_PROPOSALS_LIST_MAX } from "./rows.js";

/**
 * Request bodies and queries of the Site proposal API (KOBE-403), kept with the service like the
 * Workspace proposals' (KOBE-397). Answers are the two views in `views.ts`.
 */

/** Longest request-changes note (the Site's note to the Workspace). */
export const SITE_PROPOSAL_NOTE_MAX = 500;
export { SITE_MEMORY_PROPOSAL_ROUNDS_MAX };

const justification = z
  .string()
  .trim()
  .min(1, "Say why every workspace should know this.")
  .max(
    SITE_MEMORY_PROPOSAL_TEXT_MAX,
    `A justification is at most ${SITE_MEMORY_PROPOSAL_TEXT_MAX} characters.`,
  );

/** Propose → Site on a To review candidate (stated or confirmed, in the person's own words). */
export const proposeSiteFromCandidateSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  justification,
});
export type ProposeSiteFromCandidate = z.infer<typeof proposeSiteFromCandidateSchema>;

/** Propose to Site on an existing Workspace memory (Workspace curators). */
export const proposeSiteFromItemSchema = z.strictObject({
  item_id: z.uuid(),
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  justification,
});
export type ProposeSiteFromItem = z.infer<typeof proposeSiteFromItemSchema>;

/** A Team admin confirms, optionally editing the wording (the edit is audited). */
export const confirmSiteProposalSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  justification: justification.optional(),
});
export type ConfirmSiteProposal = z.infer<typeof confirmSiteProposalSchema>;

/** Approve as a new Site memory (Edit and approve with the fields; Policy needs a Site admin). */
export const approveSiteProposalSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  policy: z.boolean().optional(),
  overrides: semanticMemoryOverridesSchema.optional(),
});
export type ApproveSiteProposal = z.infer<typeof approveSiteProposalSchema>;

/** Merge into an existing Site memory: its new version (`statement` defaults to the proposal's). */
export const mergeSiteProposalSchema = z.strictObject({
  item_id: z.uuid(),
  statement: semanticMemoryStatementSchema.optional(),
  expected_version: z.number().int().positive().optional(),
  overrides: semanticMemoryOverridesSchema.optional(),
});
export type MergeSiteProposal = z.infer<typeof mergeSiteProposalSchema>;

export const rejectSiteProposalSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason: the workspace reads it.")
    .max(
      SITE_MEMORY_PROPOSAL_TEXT_MAX,
      `A reason is at most ${SITE_MEMORY_PROPOSAL_TEXT_MAX} characters.`,
    ),
});

export const requestSiteChangesSchema = z.strictObject({
  note: z
    .string()
    .trim()
    .min(1, "Say what to change: the workspace reads it.")
    .max(SITE_PROPOSAL_NOTE_MAX, `A note is at most ${SITE_PROPOSAL_NOTE_MAX} characters.`),
});

export const siteProposalListQuerySchema = z.strictObject({
  state: z.enum(SITE_MEMORY_PROPOSAL_STATE_VALUES).optional(),
  from_team_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(SITE_PROPOSALS_LIST_MAX).optional(),
});
export type SiteProposalListQuery = z.infer<typeof siteProposalListQuerySchema>;
