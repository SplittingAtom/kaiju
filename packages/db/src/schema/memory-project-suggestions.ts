import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import {
  SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES,
  SEMANTIC_MEMORY_KIND_VALUES,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  type SemanticMemoryKind,
} from "./semantic-memory.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

// Readers' "Suggest to editors" (v1.3 Phase B, KOBE-652 = SMB14; spec SM7, SM22, Q2): a project
// reader cannot write the project's Notes, so their learning candidate becomes a suggestion that
// the project's editors and owners (and Team admins) approve, appending it under `## Learned`
// through the signed project-memory approval, or dismiss. Team table (team_id NOT NULL, ENABLE +
// FORCE RLS, the canonical policy); RLS, the candidate ref's SET NULL (column) key and the
// legal-hold guards are SQL-only (custom migration `*_memory_project_suggestions_rls.sql`).

// `expired`: no decision within 30 days (the KOBE-651 sweep); `stale`: its thread left the project
// first, so it no longer applies (PE5; apart from `expired` since KOBE-668).
export const MEMORY_SUGGESTION_STATE_VALUES = [
  "pending",
  "approved",
  "dismissed",
  "expired",
  "stale",
] as const;
export type MemorySuggestionState = (typeof MEMORY_SUGGESTION_STATE_VALUES)[number];

/** Days a pending suggestion waits for an editor before it expires (KOBE-651 sweeps it). */
export const MEMORY_SUGGESTION_TTL_DAYS = 30;
/** Longest dismissal reason an editor may give. */
export const MEMORY_SUGGESTION_REASON_MAX = 1000;
/** Most evidence quotes a suggestion carries (each from the suggester's own messages). */
export const MEMORY_SUGGESTION_EVIDENCE_MAX = 20;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const n = (value: number) => sql.raw(String(value));
const ts = () => timestamp({ withTimezone: true });
/** Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history. */
const userRef = () => uuid().references(() => users.id);

/**
 * Team table: a project reader's suggestion (`suggested_by`) of a statement for the project's
 * Notes, made in a project thread (`thread_id`). It carries its own statement, kind and evidence
 * (a non-empty array of quotes from the suggester's own messages in that thread; the server
 * verifies them and their shape), so it survives its candidate: `candidate_ref` is a key into this
 * Workspace's candidates whose deletion clears only the ref (SQL-only `ON DELETE SET NULL
 * (column)`), and one candidate is suggested at most once. Goes with its thread (the quotes come
 * from it, SM28) and its project. An editor, owner or Team admin approves or dismisses it
 * (`decided_by`, `decided_at`, an optional `reason` on a dismissal); a pending suggestion expires
 * after 30 days, or goes stale when its thread leaves the project first (PE5), with `decided_at`
 * set and no decider.
 */
export const memoryProjectSuggestions = pgTable(
  "memory_project_suggestions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    projectId: uuid().notNull(),
    threadId: uuid().notNull(),
    candidateRef: uuid(),
    statement: text().notNull(),
    kind: text().$type<SemanticMemoryKind>().notNull(),
    evidence: jsonb().$type<unknown[]>().notNull(),
    suggestedBy: userRef().notNull(),
    state: text().$type<MemorySuggestionState>().notNull().default("pending"),
    decidedBy: userRef(),
    decidedAt: ts(),
    reason: text(),
    expiresAt: ts()
      .notNull()
      .default(sql`now() + interval '${n(MEMORY_SUGGESTION_TTL_DAYS)} days'`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "memory_project_suggestions_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_project_suggestions_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // A project's review queue (project Memory -> Suggestions; pending first, oldest first) and
    // the project key's delete checks.
    index("memory_project_suggestions_queue_idx").on(t.teamId, t.projectId, t.state, t.createdAt),
    // A thread's suggestions (staled when it leaves the project) and the thread key's checks.
    index("memory_project_suggestions_thread_idx").on(t.teamId, t.threadId),
    // A reader's own suggestions.
    index("memory_project_suggestions_suggester_idx").on(t.teamId, t.suggestedBy, t.createdAt),
    // One suggestion per candidate; also the SQL-only candidate key's delete checks.
    uniqueIndex("memory_project_suggestions_candidate_unique")
      .on(t.teamId, t.candidateRef)
      .where(sql`${t.candidateRef} IS NOT NULL`),
    // Expiry sweep of pending suggestions (KOBE-651).
    index("memory_project_suggestions_expiry_idx")
      .on(t.teamId, t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    check(
      "memory_project_suggestions_state",
      sql`${t.state} IN (${list(MEMORY_SUGGESTION_STATE_VALUES)})`,
    ),
    check(
      "memory_project_suggestions_kind",
      sql`${t.kind} IN (${list(SEMANTIC_MEMORY_KIND_VALUES)})`,
    ),
    check(
      "memory_project_suggestions_statement",
      sql`char_length(btrim(${t.statement})) >= 1 AND char_length(${t.statement}) <= ${n(SEMANTIC_MEMORY_STATEMENT_MAX)}`,
    ),
    check(
      "memory_project_suggestions_evidence",
      sql`jsonb_typeof(${t.evidence}) = 'array' AND jsonb_array_length(${t.evidence}) BETWEEN 1 AND ${n(MEMORY_SUGGESTION_EVIDENCE_MAX)} AND octet_length(${t.evidence}::text) <= ${n(SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES)}`,
    ),
    // Pending <-> undecided; approved and dismissed name the decider; expired and stale have none.
    check(
      "memory_project_suggestions_decided",
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL) AND (${t.state} IN ('approved', 'dismissed')) = (${t.decidedBy} IS NOT NULL)`,
    ),
    check(
      "memory_project_suggestions_reason",
      sql`${t.reason} IS NULL OR (${t.state} = 'dismissed' AND char_length(btrim(${t.reason})) >= 1 AND char_length(${t.reason}) <= ${n(MEMORY_SUGGESTION_REASON_MAX)})`,
    ),
  ],
);
