import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { MEMORY_PROPOSAL_TTL_DAYS } from "./semantic-memory-learning.js";
import {
  SEMANTIC_MEMORY_KIND_VALUES,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  type SemanticMemoryKind,
  siteMemoryItems,
} from "./semantic-memory.js";
import { teams } from "./teams.js";

// Site memory proposals (v1.3 Phase C, KOBE-402 = SMC1; spec SM19, SM20): a Workspace proposes a
// statement for the Site. Teams are walls: only a statement and a justification cross, after a
// Team admin's confirmation; evidence, quotes, rationale, thread or entry links and run references
// never do (no such columns; catalog test in site-memory-proposals.db.test.ts). Site-wide table
// (no team_id, no RLS), shaped like skill_promotion_requests but read only through server paths
// that filter by the caller's role; `from_team_id` is a reference, not the tenancy key. No
// SECURITY DEFINER.

export const SITE_MEMORY_PROPOSAL_STATE_VALUES = [
  "awaiting_team",
  "awaiting_site",
  "changes_requested",
  "approved",
  "merged",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type SiteMemoryProposalState = (typeof SITE_MEMORY_PROPOSAL_STATE_VALUES)[number];

/** Longest justification or reviewer reason (mirrors SEMANTIC_MEMORY_JUSTIFICATION_MAX). */
export const SITE_MEMORY_PROPOSAL_TEXT_MAX = 1000;
/** Most review rounds (changes requested and resubmitted) before a proposal must be decided. */
export const SITE_MEMORY_PROPOSAL_ROUNDS_MAX = 3;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const n = (value: number) => sql.raw(String(value));
const ts = () => timestamp({ withTimezone: true });
/** Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history. */
const userRef = () => uuid().references(() => users.id);

/**
 * Site-wide (†): one proposal of `statement` (+ `justification`) from Workspace `from_team_id` by
 * `proposer_id`. A Team admin confirms it (`team_confirmed_by`, `endorsed` when they back it) and
 * it waits for the Site (Site admins and stewards), who approve, merge it into an existing Site
 * item (`merged_into`), reject it or request changes (`decided_by`, `decided_at`, `reason`); a
 * resubmission counts a round (≤ 3). Open proposals expire at `expires_at` (a sweep sets
 * `expired`); the proposer may withdraw. A Workspace with proposals cannot be deleted: the team key
 * is ON DELETE RESTRICT (KOBE-665, Gate C decision 1), so a future Workspace deletion must check
 * legal holds and handle its proposals explicitly first; a purged Site item clears only
 * `merged_into`. The app role may not DELETE rows.
 */
export const siteMemoryProposals = pgTable(
  "site_memory_proposals",
  {
    id: uuid().primaryKey().defaultRandom(),
    fromTeamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    statement: text().notNull(),
    kind: text().$type<SemanticMemoryKind>().notNull(),
    justification: text().notNull(),
    endorsed: boolean().notNull().default(false),
    state: text().$type<SiteMemoryProposalState>().notNull().default("awaiting_team"),
    rounds: integer().notNull().default(0),
    proposerId: userRef().notNull(),
    teamConfirmedBy: userRef(),
    teamConfirmedAt: ts(),
    decidedBy: userRef(),
    decidedAt: ts(),
    reason: text(),
    mergedInto: uuid().references(() => siteMemoryItems.id, { onDelete: "set null" }),
    expiresAt: ts()
      .notNull()
      .default(sql`now() + interval '${n(MEMORY_PROPOSAL_TTL_DAYS)} days'`),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    // The Site queue (awaiting_site, oldest first), a Workspace's queue and a proposer's list.
    index("site_memory_proposals_queue_idx").on(t.state, t.createdAt),
    index("site_memory_proposals_team_idx").on(t.fromTeamId, t.state, t.createdAt),
    index("site_memory_proposals_proposer_idx").on(t.proposerId, t.createdAt),
    // Expiry sweep of open proposals.
    index("site_memory_proposals_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.state} IN ('awaiting_team', 'awaiting_site', 'changes_requested')`),
    // The merged_into key's delete check.
    index("site_memory_proposals_merged_idx")
      .on(t.mergedInto)
      .where(sql`${t.mergedInto} IS NOT NULL`),
    check(
      "site_memory_proposals_state",
      sql`${t.state} IN (${list(SITE_MEMORY_PROPOSAL_STATE_VALUES)})`,
    ),
    check(
      "site_memory_proposals_rounds",
      sql`${t.rounds} BETWEEN 0 AND ${n(SITE_MEMORY_PROPOSAL_ROUNDS_MAX)}`,
    ),
    check("site_memory_proposals_kind", sql`${t.kind} IN (${list(SEMANTIC_MEMORY_KIND_VALUES)})`),
    check(
      "site_memory_proposals_statement",
      sql`char_length(btrim(${t.statement})) >= 1 AND char_length(${t.statement}) <= ${n(SEMANTIC_MEMORY_STATEMENT_MAX)}`,
    ),
    check(
      "site_memory_proposals_justification",
      sql`char_length(btrim(${t.justification})) >= 1 AND char_length(${t.justification}) <= ${n(SITE_MEMORY_PROPOSAL_TEXT_MAX)}`,
    ),
    check(
      "site_memory_proposals_reason",
      sql`${t.reason} IS NULL OR (char_length(btrim(${t.reason})) >= 1 AND char_length(${t.reason}) <= ${n(SITE_MEMORY_PROPOSAL_TEXT_MAX)})`,
    ),
    // Past the team only with a Team admin's confirmation.
    check(
      "site_memory_proposals_team_confirmed",
      sql`${t.state} NOT IN ('awaiting_site', 'approved', 'merged') OR ${t.teamConfirmedBy} IS NOT NULL`,
    ),
    // A decision names who took it (a Team admin's rejection, or the Site's decision).
    check(
      "site_memory_proposals_decided",
      sql`${t.state} NOT IN ('changes_requested', 'approved', 'merged', 'rejected') OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    // A merge target only on a merged proposal (cleared by a purge of that Site item).
    check("site_memory_proposals_merged", sql`${t.mergedInto} IS NULL OR ${t.state} = 'merged'`),
  ],
);
