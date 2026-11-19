import { z } from "zod";
import { semanticMemoryKindSchema, type SemanticMemoryKind } from "@kobe/protocol";
import { sql, type KobeTx, type MemorySuggestionState } from "@kobe/db";
import { notifyMemoryAll, settleMemoryReminders } from "../../notifications/memory.js";
import { MemoryItemError } from "../items/errors.js";

/**
 * The rows of readers' suggestions to a project's Notes (KOBE-652, `memory_project_suggestions`):
 * reading them (each row parsed again: data, never trusted), locking one for a decision, who
 * decides a project's suggestions, and staling the ones whose thread left their project (PE5).
 */

export const evidenceSchema = z
  .array(z.object({ entry_id: z.string().min(1), quote: z.string().min(1) }))
  .min(1);
export type SuggestionEvidence = z.infer<typeof evidenceSchema>;

export interface SuggestionRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly threadId: string;
  readonly statement: string;
  readonly kind: SemanticMemoryKind;
  readonly evidence: SuggestionEvidence;
  readonly suggestedBy: string;
  readonly suggesterName: string;
  readonly state: MemorySuggestionState;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  /** `expires_at` has passed (the KOBE-651 sweep marks it later). */
  readonly expired: boolean;
  /** The thread's project now (null: none); differs from `projectId` once it moved (PE5). */
  readonly threadProjectId: string | null;
}

type Raw = {
  id: string;
  project_id: string;
  project_name: string;
  thread_id: string;
  statement: string;
  kind: unknown;
  evidence: unknown;
  suggested_by: string;
  suggester_name: string;
  state: SuggestionRow["state"];
  reason: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  decided_at: string | Date | null;
  expired: boolean;
  thread_project_id: string | null;
};

const iso = (v: string | Date) => new Date(v).toISOString();

function toRow(r: Raw): SuggestionRow | null {
  const kind = semanticMemoryKindSchema.safeParse(r.kind);
  const evidence = evidenceSchema.safeParse(r.evidence);
  if (!kind.success || !evidence.success) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    threadId: r.thread_id,
    statement: r.statement,
    kind: kind.data,
    evidence: evidence.data,
    suggestedBy: r.suggested_by,
    suggesterName: r.suggester_name,
    state: r.state,
    reason: r.reason,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    decidedAt: r.decided_at === null ? null : iso(r.decided_at),
    expired: r.expired,
    threadProjectId: r.thread_project_id,
  };
}

const COLUMNS = sql`s.id, s.project_id, p.name AS project_name, s.thread_id, s.statement, s.kind,
  s.evidence, s.suggested_by, u.name AS suggester_name, s.state, s.reason, s.created_at,
  s.expires_at, s.decided_at, s.expires_at <= now() AS expired, t.project_id AS thread_project_id`;
const FROM = sql`memory_project_suggestions s
  JOIN projects p ON p.team_id = s.team_id AND p.id = s.project_id
  JOIN threads t ON t.team_id = s.team_id AND t.id = s.thread_id
  JOIN users u ON u.id = s.suggested_by`;
/** Waiting for a decision: pending, unexpired, its thread still in its project. */
const OPEN = sql`s.state = 'pending' AND s.expires_at > now() AND t.project_id = s.project_id`;

/** SQL: `userId` decides project `s.project_id`'s suggestions (owner, editor, Team admin). */
const decides = (teamId: string, userId: string) => sql`(
  EXISTS (SELECT 1 FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}
            AND role = 'team_admin')
  OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.team_id = ${teamId}
               AND pm.project_id = s.project_id AND pm.user_id = ${userId}
               AND pm.role IN ('owner', 'editor')))`;

const LIST_MAX = 100;
const MINE_MAX = 50;

function rowsOf(raw: readonly Raw[]): SuggestionRow[] {
  return raw.map(toRow).filter((r): r is SuggestionRow => r !== null);
}

/** The open suggestions `userId` may decide: one project's, or every project's (To review). */
export async function decidableSuggestions(
  tx: KobeTx,
  ids: { teamId: string; userId: string },
  projectId?: string,
): Promise<SuggestionRow[]> {
  const project = projectId === undefined ? sql`` : sql`AND s.project_id = ${projectId}`;
  const { rows } = await tx.execute<Raw>(sql`
    SELECT ${COLUMNS} FROM ${FROM}
     WHERE s.team_id = ${ids.teamId} AND ${OPEN} ${project}
       AND ${decides(ids.teamId, ids.userId)}
     ORDER BY s.created_at ASC LIMIT ${LIST_MAX}`);
  return rowsOf(rows);
}

/** The caller's own suggestions in a project, newest first, in every state. */
export async function ownSuggestions(
  tx: KobeTx,
  ids: { teamId: string; userId: string },
  projectId: string,
): Promise<SuggestionRow[]> {
  const { rows } = await tx.execute<Raw>(sql`
    SELECT ${COLUMNS} FROM ${FROM}
     WHERE s.team_id = ${ids.teamId} AND s.project_id = ${projectId}
       AND s.suggested_by = ${ids.userId}
     ORDER BY s.created_at DESC LIMIT ${MINE_MAX}`);
  return rowsOf(rows);
}

export const suggestionNotFound = () =>
  new MemoryItemError("memory_item_not_found", "No such suggestion in a project you can see.");

/** One suggestion, row-locked for a decision (any state: the caller checks). */
export async function lockSuggestion(
  tx: KobeTx,
  teamId: string,
  id: string,
): Promise<SuggestionRow> {
  const { rows } = await tx.execute<Raw>(sql`
    SELECT ${COLUMNS} FROM ${FROM}
     WHERE s.team_id = ${teamId} AND s.id = ${id}
     FOR UPDATE OF s`);
  const raw = rows[0];
  const row = raw ? toRow(raw) : null;
  if (!row) throw suggestionNotFound();
  return row;
}

/** Who decides a project's suggestions: its owners and editors and the Team admins. */
export async function decidersOf(tx: KobeTx, teamId: string, projectId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM project_members
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND role IN ('owner', 'editor')
    UNION
    SELECT user_id FROM team_members WHERE team_id = ${teamId} AND role = 'team_admin'
    ORDER BY user_id`);
  return rows.map((r) => r.user_id);
}

/**
 * PE5: pending suggestions of `threadId` (or of the whole Workspace) whose thread is no longer in
 * their project go `stale` now (KOBE-668; `expired` is only the 30-day sweep): their reminders are
 * settled and each suggester is told (`memory.suggestion.stale`). Call it last in the transaction
 * (it notifies). Returns the ids it staled.
 */
export async function staleMovedSuggestions(
  tx: KobeTx,
  teamId: string,
  threadId?: string,
): Promise<string[]> {
  const thread = threadId === undefined ? sql`` : sql`AND s.thread_id = ${threadId}`;
  const { rows } = await tx.execute<{ id: string; project_id: string; suggested_by: string }>(sql`
    UPDATE memory_project_suggestions s SET state = 'stale', decided_at = now()
      FROM threads t
     WHERE s.team_id = ${teamId} AND t.team_id = s.team_id AND t.id = s.thread_id
       AND s.state = 'pending' AND t.project_id IS DISTINCT FROM s.project_id ${thread}
    RETURNING s.id, s.project_id, s.suggested_by`);
  if (rows.length === 0) return [];
  for (const r of rows) await settleMemoryReminders(tx, teamId, r.id);
  await notifyMemoryAll(
    tx,
    teamId,
    rows.map((r) => ({
      recipients: [r.suggested_by],
      notice: { kind: "memory.suggestion.stale", objectId: r.id, projectId: r.project_id },
    })),
  );
  return rows.map((r) => r.id);
}
