import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import {
  SEMANTIC_MEMORY_KIND_VALUES,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  type SemanticMemoryKind,
} from "./semantic-memory.js";
import { teams } from "./teams.js";
import { threadEntries, threads } from "./threads.js";

// Semantic memory learning (v1.3 Phase B, KOBE-389 = SMB1; spec SM13, SM15, SM16, SM18, SM22):
// a thread author's learning pass over a conversation branch, the candidates it found (reviewed
// one by one before anything is saved), the person's dismissals and learning watermark, and
// Workspace proposals to curators. All team tables (team_id NOT NULL, ENABLE + FORCE RLS, the
// canonical policy). RLS, the proposals' SET NULL (column) keys and the legal-hold guards are
// SQL-only (custom migration `*_memory_learning_rls.sql`). Everything tied to a thread goes with
// it (SM28): passes, their candidates, dismissals and watermarks cascade from the thread; a
// proposal keeps its own statement and loses only its candidate link.

export const MEMORY_PASS_STATUS_VALUES = ["queued", "running", "completed", "failed"] as const;
export type MemoryPassStatus = (typeof MEMORY_PASS_STATUS_VALUES)[number];
/** Statuses that hold a thread's one pass slot (across server replicas). */
export const MEMORY_PASS_ACTIVE_STATUS_VALUES = ["queued", "running"] as const;

export const MEMORY_CANDIDATE_STATE_VALUES = [
  "open",
  "saved",
  "proposed",
  "suggested",
  "dismissed",
  "expired",
] as const;
export type MemoryCandidateState = (typeof MEMORY_CANDIDATE_STATE_VALUES)[number];

export const MEMORY_PROPOSAL_STATE_VALUES = ["pending", "approved", "rejected", "expired"] as const;
export type MemoryProposalState = (typeof MEMORY_PROPOSAL_STATE_VALUES)[number];

/** Where a Workspace proposal came from: a learning candidate or an existing personal item. */
export const MEMORY_PROPOSAL_SOURCE_VALUES = ["candidate", "item"] as const;
export type MemoryProposalSource = (typeof MEMORY_PROPOSAL_SOURCE_VALUES)[number];

/** Days an open candidate waits in To review before it expires (SM16). */
export const MEMORY_CANDIDATE_TTL_DAYS = 14;
/** Days a pending Workspace proposal waits for a curator before it expires (SM22). */
export const MEMORY_PROPOSAL_TTL_DAYS = 30;
/** Longest model alias or prompt version recorded on a pass. */
export const MEMORY_PASS_LABEL_MAX = 240;
/** Longest pass error kept (a code and short message; never model output). */
export const MEMORY_PASS_ERROR_MAX = 2000;
/** Backstop for a pass's usage record (tokens, cost); the server writes a few numbers. */
export const MEMORY_PASS_USAGE_MAX_BYTES = 4 * 1024;
/** Backstop for one candidate's payload (statement, kind, scope, evidence quotes, rationale). */
export const MEMORY_CANDIDATE_PAYLOAD_MAX_BYTES = 32 * 1024;
/** Longest proposal rationale or curator reason. */
export const MEMORY_PROPOSAL_TEXT_MAX = 1000;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const n = (value: number) => sql.raw(String(value));
const ts = () => timestamp({ withTimezone: true });
const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });
/** Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history. */
const userRef = () => uuid().references(() => users.id);
/**
 * Team table: one learning pass (SM13, SM15) of `user_id` (the thread's author) over the branch
 * ending at `branch_leaf_entry_id`, reading the entries after `from_entry_id` (null = from the
 * root, or from the lowest common ancestor after a branch switch, KOBE-392) up to `to_entry_id`
 * (set when it completes). One queued or running pass per thread across server replicas
 * (`memory_learning_passes_active_unique`; `background.ts` runs per replica). `usage` is the
 * model call's token record (charged to team and user by the server); `error` a short code and
 * message, only on a failed pass.
 */
export const memoryLearningPasses = pgTable(
  "memory_learning_passes",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    userId: userRef().notNull(),
    branchLeafEntryId: text().notNull(),
    fromEntryId: text(),
    toEntryId: text(),
    modelAlias: text().notNull(),
    promptVersion: text().notNull(),
    status: text().$type<MemoryPassStatus>().notNull().default("queued"),
    usage: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "memory_learning_passes_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // Entries are entries of the pass's thread (they only ever go with it).
    foreignKey({
      name: "memory_learning_passes_leaf_fk",
      columns: [t.teamId, t.threadId, t.branchLeafEntryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_learning_passes_from_fk",
      columns: [t.teamId, t.threadId, t.fromEntryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_learning_passes_to_fk",
      columns: [t.teamId, t.threadId, t.toEntryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
    // One pass per thread at a time, whoever asked (ac-2).
    uniqueIndex("memory_learning_passes_active_unique")
      .on(t.teamId, t.threadId)
      .where(sql`${t.status} IN (${list(MEMORY_PASS_ACTIVE_STATUS_VALUES)})`),
    // A thread's passes (newest first) and the thread key's delete checks.
    index("memory_learning_passes_thread_idx").on(t.teamId, t.threadId, t.createdAt),
    // A person's passes (To review across their threads).
    index("memory_learning_passes_user_idx").on(t.teamId, t.userId, t.createdAt),
    // Retention sweep of finished passes (KOBE-651).
    index("memory_learning_passes_finished_idx")
      .on(t.teamId, t.finishedAt)
      .where(sql`${t.finishedAt} IS NOT NULL`),
    check(
      "memory_learning_passes_status",
      sql`${t.status} IN (${list(MEMORY_PASS_STATUS_VALUES)})`,
    ),
    check(
      "memory_learning_passes_finished",
      sql`(${t.status} IN ('completed', 'failed')) = (${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      "memory_learning_passes_completed",
      sql`${t.status} <> 'completed' OR ${t.toEntryId} IS NOT NULL`,
    ),
    check(
      "memory_learning_passes_error",
      sql`(${t.status} = 'failed') = (${t.error} IS NOT NULL) AND (${t.error} IS NULL OR char_length(${t.error}) BETWEEN 1 AND ${n(MEMORY_PASS_ERROR_MAX)})`,
    ),
    check(
      "memory_learning_passes_labels",
      sql`char_length(${t.modelAlias}) BETWEEN 1 AND ${n(MEMORY_PASS_LABEL_MAX)} AND char_length(${t.promptVersion}) BETWEEN 1 AND ${n(MEMORY_PASS_LABEL_MAX)}`,
    ),
    check(
      "memory_learning_passes_usage",
      sql`${t.usage} IS NULL OR (jsonb_typeof(${t.usage}) = 'object' AND octet_length(${t.usage}::text) <= ${n(MEMORY_PASS_USAGE_MAX_BYTES)})`,
    ),
  ],
);

/**
 * Team table: one candidate a pass found, in the pass's order (`ord`). `payload` is the verified
 * candidate (statement, kind, scope, evidence quotes, rationale) shown in To review; the server
 * validates its shape. `state` moves from `open` once the author saves it (an item), proposes it
 * to curators, suggests it to a project's editors, dismisses it, or it expires after 14 days
 * (`decided_at` records when). Goes with its pass, and so with the thread.
 */
export const memoryCandidates = pgTable(
  "memory_candidates",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    passId: uuid().notNull(),
    ord: integer().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    state: text().$type<MemoryCandidateState>().notNull().default("open"),
    expiresAt: ts()
      .notNull()
      .default(sql`now() + interval '${n(MEMORY_CANDIDATE_TTL_DAYS)} days'`),
    decidedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "memory_candidates_pass_fk",
      columns: [t.teamId, t.passId],
      foreignColumns: [memoryLearningPasses.teamId, memoryLearningPasses.id],
    }).onDelete("cascade"),
    // Also the pass key's delete checks and a pass's candidates in order.
    unique("memory_candidates_pass_ord_unique").on(t.teamId, t.passId, t.ord),
    // Expiry sweep of open candidates (ac-2, KOBE-651).
    index("memory_candidates_expiry_idx")
      .on(t.teamId, t.expiresAt)
      .where(sql`${t.state} = 'open'`),
    check("memory_candidates_state", sql`${t.state} IN (${list(MEMORY_CANDIDATE_STATE_VALUES)})`),
    check("memory_candidates_decided", sql`(${t.state} = 'open') = (${t.decidedAt} IS NULL)`),
    check("memory_candidates_ord", sql`${t.ord} >= 0`),
    check(
      "memory_candidates_payload",
      sql`jsonb_typeof(${t.payload}) = 'object' AND octet_length(${t.payload}::text) <= ${n(MEMORY_CANDIDATE_PAYLOAD_MAX_BYTES)}`,
    ),
  ],
);

/**
 * Team table: a statement a person dismissed in a thread (SM16), so later passes over the thread
 * don't offer it to them again. Per person; `statement_hash` is the lowercase hex SHA-256 of the
 * normalized statement (the server normalizes). Goes with the thread.
 */
export const memoryDismissals = pgTable(
  "memory_dismissals",
  {
    teamId: teamRef(),
    threadId: uuid().notNull(),
    userId: userRef().notNull(),
    statementHash: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    // Also the thread key's delete checks.
    primaryKey({ columns: [t.teamId, t.threadId, t.userId, t.statementHash] }),
    foreignKey({
      name: "memory_dismissals_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    check("memory_dismissals_hash", sql`${t.statementHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Team table: the last entry a person's passes learned in a thread (SM15). The next pass continues
 * after it when it is an ancestor of the current leaf (walk `thread_entries.parent_id` up from the
 * leaf), else rescans from their lowest common ancestor (KOBE-392). A key into `thread_entries`, so
 * the id always names an entry of this thread. Goes with the thread.
 */
export const memoryLearningWatermarks = pgTable(
  "memory_learning_watermarks",
  {
    teamId: teamRef(),
    threadId: uuid().notNull(),
    userId: userRef().notNull(),
    entryId: text().notNull(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    // Also the thread and entry keys' delete checks.
    primaryKey({ columns: [t.teamId, t.threadId, t.userId] }),
    foreignKey({
      name: "memory_learning_watermarks_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_learning_watermarks_entry_fk",
      columns: [t.teamId, t.threadId, t.entryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
  ],
);

/**
 * Team table: a member's proposal of a statement to the Workspace's curators (SM22), from a
 * learning candidate (`source = 'candidate'`) or an existing personal item (`source = 'item'`).
 * The proposal carries its own statement, kind and rationale, so it survives its source: the
 * refs are keys into this Workspace whose deletion clears only the ref (SQL-only
 * `ON DELETE SET NULL (column)`; a purged thread takes its candidates, SM28). A curator approves
 * or rejects it (`decided_by`, `decided_at`, optional `reason`); a pending proposal expires after
 * 30 days (`decided_at` set, no curator).
 */
export const memoryProposals = pgTable(
  "memory_proposals",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    source: text().$type<MemoryProposalSource>().notNull(),
    candidateRef: uuid(),
    itemRef: uuid(),
    statement: text().notNull(),
    kind: text().$type<SemanticMemoryKind>().notNull(),
    rationale: text(),
    state: text().$type<MemoryProposalState>().notNull().default("pending"),
    proposerId: userRef().notNull(),
    decidedBy: userRef(),
    decidedAt: ts(),
    reason: text(),
    expiresAt: ts()
      .notNull()
      .default(sql`now() + interval '${n(MEMORY_PROPOSAL_TTL_DAYS)} days'`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // Curators' queue (pending first, oldest first) and a member's own proposals.
    index("memory_proposals_state_idx").on(t.teamId, t.state, t.createdAt),
    index("memory_proposals_proposer_idx").on(t.teamId, t.proposerId, t.createdAt),
    // The SQL-only ref keys' delete checks.
    index("memory_proposals_candidate_idx")
      .on(t.teamId, t.candidateRef)
      .where(sql`${t.candidateRef} IS NOT NULL`),
    index("memory_proposals_item_idx")
      .on(t.teamId, t.itemRef)
      .where(sql`${t.itemRef} IS NOT NULL`),
    // Expiry sweep of pending proposals (ac-2, KOBE-651).
    index("memory_proposals_expiry_idx")
      .on(t.teamId, t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    check("memory_proposals_source", sql`${t.source} IN (${list(MEMORY_PROPOSAL_SOURCE_VALUES)})`),
    // A ref matches its source (a cleared ref is null; the other is always null).
    check(
      "memory_proposals_refs",
      sql`(${t.source} = 'candidate' AND ${t.itemRef} IS NULL) OR (${t.source} = 'item' AND ${t.candidateRef} IS NULL)`,
    ),
    check("memory_proposals_state", sql`${t.state} IN (${list(MEMORY_PROPOSAL_STATE_VALUES)})`),
    check("memory_proposals_kind", sql`${t.kind} IN (${list(SEMANTIC_MEMORY_KIND_VALUES)})`),
    check(
      "memory_proposals_statement",
      sql`char_length(btrim(${t.statement})) >= 1 AND char_length(${t.statement}) <= ${n(SEMANTIC_MEMORY_STATEMENT_MAX)}`,
    ),
    check(
      "memory_proposals_decided",
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL) AND (${t.state} IN ('approved', 'rejected')) = (${t.decidedBy} IS NOT NULL)`,
    ),
    check(
      "memory_proposals_reason",
      sql`${t.reason} IS NULL OR (${t.state} <> 'pending' AND char_length(${t.reason}) BETWEEN 1 AND ${n(MEMORY_PROPOSAL_TEXT_MAX)})`,
    ),
    check(
      "memory_proposals_rationale",
      sql`${t.rationale} IS NULL OR char_length(${t.rationale}) BETWEEN 1 AND ${n(MEMORY_PROPOSAL_TEXT_MAX)}`,
    ),
  ],
);
