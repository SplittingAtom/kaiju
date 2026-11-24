import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { recordAudit } from "../audit/record.js";
import {
  notifyMemoryAll,
  settleMemoryReminders,
  type MemoryNoticeFor,
} from "../notifications/memory.js";
import { activeMember } from "./semantic-memory.js";

/**
 * Retention of the Learn from this chat records in a Workspace (v1.3 SMB13, KOBE-651; SM16, SM22,
 * SM28), a step of the nightly team pass (one runner across replicas: the retention job's lock).
 * Every batch runs in one team transaction that takes the legal-hold lock first and skips people a
 * hold covers (`legal_hold_covers`: a hold on the person or on the Workspace, the rule the 0229 and
 * 0232 delete guards apply). A Site-wide hold covers Site memories only (KOBE-647), not these rows.
 *  - open To review candidates past `expires_at` (14 days) become `expired`; never a dismissal, so
 *    a later pass may find the statement again. A pass's reminder is settled once none of its
 *    candidates is open;
 *  - pending Workspace proposals and readers' project suggestions past `expires_at` (30 days;
 *    request rounds keep the clock, KOBE-397) become `expired`: the curators' or editors' reminders
 *    are settled and the proposer or reader is told, once (the state change and the notice share
 *    the transaction);
 *  - finished learning passes (with their usage record and candidates) go once finished longer ago
 *    than the Workspace window (nothing while the Workspace keeps forever), except a pass with a
 *    candidate still open or still shown by a pending proposal or suggestion. The decided
 *    proposals and suggestions made from its candidates go with it (KOBE-671); a decided one not
 *    from a pass (or whose pass already left) goes once decided longer ago than the window. A
 *    hold on the proposer, reader or decider keeps it, and its pass. Pending ones only expire.
 * Thread purge needs nothing here: passes, candidates, dismissals, watermarks and suggestions go
 * with their conversation by cascade; proposals keep their own words (`candidate_ref` cleared).
 * Offboarding ({@link purgeDepartedLearningInTx}) erases what a departed member left.
 * Audited with counts only (`retention.memory_learning_purged`).
 */

const BATCH = 200;

export interface LearningPurgeCounts {
  readonly candidatesExpired: number;
  readonly proposalsExpired: number;
  readonly suggestionsExpired: number;
  readonly passes: number;
  readonly candidates: number;
  readonly dismissals: number;
  readonly watermarks: number;
  readonly proposals: number;
  readonly suggestions: number;
}

export const NO_LEARNING_PURGE: LearningPurgeCounts = {
  candidatesExpired: 0,
  proposalsExpired: 0,
  suggestionsExpired: 0,
  passes: 0,
  candidates: 0,
  dismissals: 0,
  watermarks: 0,
  proposals: 0,
  suggestions: 0,
};

const KEYS = Object.keys(NO_LEARNING_PURGE) as (keyof LearningPurgeCounts)[];

const add = (a: LearningPurgeCounts, b: LearningPurgeCounts): LearningPurgeCounts =>
  Object.fromEntries(KEYS.map((k) => [k, a[k] + b[k]])) as unknown as LearningPurgeCounts;

const total = (c: LearningPurgeCounts) => KEYS.reduce((n, k) => n + c[k], 0);

async function audited(
  tx: KaijuTx,
  teamId: string,
  reason: "retention" | "offboarding",
  counts: LearningPurgeCounts,
  userId?: string,
): Promise<void> {
  // An offboarding erasure is always recorded, even one that found nothing (as KOBE-386 L2).
  if (reason === "retention" && total(counts) === 0) return;
  await recordAudit(tx, {
    action: "retention.memory_learning_purged",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { reason, ...counts, ...(userId ? { userId } : {}) },
  });
}

/** Open candidates past their 14 days; settles the reminder of each pass left with none open. */
async function expireCandidates(tx: KaijuTx, teamId: string): Promise<LearningPurgeCounts> {
  const res = await tx.execute<{ pass_id: string }>(sql`
    WITH due AS (
      SELECT c.id FROM memory_candidates c
        JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
       WHERE c.team_id = ${teamId} AND c.state = 'open' AND c.expires_at <= now()
         AND NOT public.legal_hold_covers(p.team_id, p.user_id)
       ORDER BY c.expires_at, c.id LIMIT ${BATCH}
         FOR UPDATE OF c SKIP LOCKED)
    UPDATE memory_candidates c SET state = 'expired', decided_at = now()
      FROM due WHERE c.team_id = ${teamId} AND c.id = due.id
    RETURNING c.pass_id`);
  const passes = [...new Set(res.rows.map((r) => r.pass_id))];
  for (const passId of passes) {
    const open = await tx.execute(sql`
      SELECT 1 FROM memory_candidates
       WHERE team_id = ${teamId} AND pass_id = ${passId} AND state = 'open' LIMIT 1`);
    if (open.rowCount === 0) await settleMemoryReminders(tx, teamId, passId);
  }
  return { ...NO_LEARNING_PURGE, candidatesExpired: res.rows.length };
}

/** Pending proposals past their 30 days: reminders settled, the proposer told (notify last). */
async function expireProposals(tx: KaijuTx, teamId: string): Promise<LearningPurgeCounts> {
  const res = await tx.execute<{ id: string; proposer_id: string }>(sql`
    WITH due AS (
      SELECT id FROM memory_proposals
       WHERE team_id = ${teamId} AND state = 'pending' AND expires_at <= now()
         AND NOT public.legal_hold_covers(team_id, proposer_id)
       ORDER BY expires_at, id LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED)
    UPDATE memory_proposals r SET state = 'expired', decided_at = now()
      FROM due WHERE r.team_id = ${teamId} AND r.id = due.id
    RETURNING r.id, r.proposer_id`);
  for (const r of res.rows) await settleMemoryReminders(tx, teamId, r.id);
  await notifyMemoryAll(
    tx,
    teamId,
    res.rows.map((r): MemoryNoticeFor => ({
      recipients: [r.proposer_id],
      notice: { kind: "memory.proposal.expired", objectId: r.id },
    })),
  );
  return { ...NO_LEARNING_PURGE, proposalsExpired: res.rows.length };
}

/** Pending suggestions past their 30 days: reminders settled, the reader told (notify last). */
async function expireSuggestions(tx: KaijuTx, teamId: string): Promise<LearningPurgeCounts> {
  const res = await tx.execute<{ id: string; suggested_by: string; project_id: string }>(sql`
    WITH due AS (
      SELECT id FROM memory_project_suggestions
       WHERE team_id = ${teamId} AND state = 'pending' AND expires_at <= now()
         AND NOT public.legal_hold_covers(team_id, suggested_by)
       ORDER BY expires_at, id LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED)
    UPDATE memory_project_suggestions s SET state = 'expired', decided_at = now()
      FROM due WHERE s.team_id = ${teamId} AND s.id = due.id
    RETURNING s.id, s.suggested_by, s.project_id`);
  for (const r of res.rows) await settleMemoryReminders(tx, teamId, r.id);
  await notifyMemoryAll(
    tx,
    teamId,
    res.rows.map((r): MemoryNoticeFor => ({
      recipients: [r.suggested_by],
      notice: { kind: "memory.suggestion.expired", objectId: r.id, projectId: r.project_id },
    })),
  );
  return { ...NO_LEARNING_PURGE, suggestionsExpired: res.rows.length };
}

/**
 * Whether a hold covers anyone a decided proposal (`r`) or suggestion (`s`) involves: the proposer
 * or reader, and the decider (none on an expired one). A Workspace-wide hold covers everyone.
 */
const proposalHeld = sql`(public.legal_hold_covers(r.team_id, r.proposer_id)
  OR (r.decided_by IS NOT NULL AND public.legal_hold_covers(r.team_id, r.decided_by)))`;
const suggestionHeld = sql`(public.legal_hold_covers(s.team_id, s.suggested_by)
  OR (s.decided_by IS NOT NULL AND public.legal_hold_covers(s.team_id, s.decided_by)))`;

/** Reminders and bell entries about purged proposals or suggestions (they would open nothing). */
async function dropNotices(tx: KaijuTx, teamId: string, objects: readonly string[]): Promise<void> {
  if (objects.length === 0) return;
  const list = sql.join(
    objects.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    DELETE FROM memory_reminders WHERE team_id = ${teamId} AND object_id IN (${list})`);
  await tx.execute(sql`
    DELETE FROM notifications WHERE team_id = ${teamId} AND memory_object_id IN (${list})`);
}

/**
 * Finished passes past the window, with their candidates (cascade) and the decided proposals and
 * suggestions made from those candidates (KOBE-671), unless still in use (a candidate open or
 * shown by a pending proposal or suggestion) or a hold covers the pass's person or anyone a
 * proposal or suggestion of it involves. Proposals and suggestions go first, in their own
 * statements, so the candidates' `ON DELETE SET NULL` refs never touch a row being deleted.
 */
async function purgePasses(
  tx: KaijuTx,
  teamId: string,
  cutoff: Date,
): Promise<LearningPurgeCounts> {
  const doomed = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM memory_learning_passes p
     WHERE p.team_id = ${teamId} AND p.finished_at IS NOT NULL
       AND p.finished_at < ${cutoff.toISOString()}
       AND NOT public.legal_hold_covers(p.team_id, p.user_id)
       AND NOT EXISTS (
         SELECT 1 FROM memory_candidates c
          WHERE c.team_id = p.team_id AND c.pass_id = p.id
            AND (c.state = 'open'
                 OR EXISTS (SELECT 1 FROM memory_proposals r
                             WHERE r.team_id = c.team_id AND r.candidate_ref = c.id
                               AND (r.state = 'pending' OR ${proposalHeld}))
                 OR EXISTS (SELECT 1 FROM memory_project_suggestions s
                             WHERE s.team_id = c.team_id AND s.candidate_ref = c.id
                               AND (s.state = 'pending' OR ${suggestionHeld}))))
     ORDER BY p.finished_at, p.id LIMIT ${BATCH}
       FOR UPDATE OF p SKIP LOCKED`);
  const passIds = doomed.rows.map((r) => r.id);
  if (passIds.length === 0) return NO_LEARNING_PURGE;
  const passes = sql.join(
    passIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const fromPasses = sql`(SELECT c.id FROM memory_candidates c
    WHERE c.team_id = ${teamId} AND c.pass_id IN (${passes}))`;
  const proposals = await tx.execute<{ id: string }>(sql`
    DELETE FROM memory_proposals
     WHERE team_id = ${teamId} AND state <> 'pending' AND candidate_ref IN ${fromPasses}
     RETURNING id`);
  const suggestions = await tx.execute<{ id: string }>(sql`
    DELETE FROM memory_project_suggestions
     WHERE team_id = ${teamId} AND state <> 'pending' AND candidate_ref IN ${fromPasses}
     RETURNING id`);
  await dropNotices(
    tx,
    teamId,
    [...proposals.rows, ...suggestions.rows].map((r) => r.id),
  );
  const res = await tx.execute<{ passes: number; candidates: number }>(sql`
    WITH counted AS (
      SELECT count(*)::int AS n FROM ${fromPasses} x),
    gone AS (
      DELETE FROM memory_learning_passes p
       WHERE p.team_id = ${teamId} AND p.id IN (${passes})
       RETURNING p.id)
    SELECT (SELECT count(*) FROM gone)::int AS passes, (SELECT n FROM counted) AS candidates`);
  const row = res.rows[0];
  return {
    ...NO_LEARNING_PURGE,
    passes: row?.passes ?? 0,
    candidates: row?.candidates ?? 0,
    proposals: proposals.rows.length,
    suggestions: suggestions.rows.length,
  };
}

/**
 * Decided proposals and suggestions not from a pass (proposed from an existing item, or whose
 * candidate already left with its pass or conversation), once decided longer ago than the
 * Workspace window and no hold covers anyone they involve (KOBE-671).
 */
async function purgeDecided(
  tx: KaijuTx,
  teamId: string,
  cutoff: Date,
): Promise<LearningPurgeCounts> {
  const proposals = await tx.execute<{ id: string }>(sql`
    WITH due AS (
      SELECT r.id FROM memory_proposals r
       WHERE r.team_id = ${teamId} AND r.state <> 'pending' AND r.candidate_ref IS NULL
         AND r.decided_at < ${cutoff.toISOString()} AND NOT ${proposalHeld}
       ORDER BY r.decided_at, r.id LIMIT ${BATCH}
         FOR UPDATE OF r SKIP LOCKED)
    DELETE FROM memory_proposals r USING due
     WHERE r.team_id = ${teamId} AND r.id = due.id
     RETURNING r.id`);
  const suggestions = await tx.execute<{ id: string }>(sql`
    WITH due AS (
      SELECT s.id FROM memory_project_suggestions s
       WHERE s.team_id = ${teamId} AND s.state <> 'pending' AND s.candidate_ref IS NULL
         AND s.decided_at < ${cutoff.toISOString()} AND NOT ${suggestionHeld}
       ORDER BY s.decided_at, s.id LIMIT ${BATCH}
         FOR UPDATE OF s SKIP LOCKED)
    DELETE FROM memory_project_suggestions s USING due
     WHERE s.team_id = ${teamId} AND s.id = due.id
     RETURNING s.id`);
  await dropNotices(
    tx,
    teamId,
    [...proposals.rows, ...suggestions.rows].map((r) => r.id),
  );
  return {
    ...NO_LEARNING_PURGE,
    proposals: proposals.rows.length,
    suggestions: suggestions.rows.length,
  };
}

/** One batch in its own team transaction, hold lock first; audited when it changed something. */
function batch(
  db: KaijuDb,
  teamId: string,
  one: (tx: KaijuTx) => Promise<LearningPurgeCounts>,
): Promise<LearningPurgeCounts> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const counts = await one(tx);
    await audited(tx, teamId, "retention", counts);
    return counts;
  });
}

async function repeat(
  db: KaijuDb,
  teamId: string,
  stop: (() => boolean) | undefined,
  one: (tx: KaijuTx) => Promise<LearningPurgeCounts>,
): Promise<LearningPurgeCounts> {
  let sum = NO_LEARNING_PURGE;
  for (let n = 0; n < 1000; n++) {
    if (stop?.()) break;
    const counts = await batch(db, teamId, one);
    sum = add(sum, counts);
    if (total(counts) === 0) break;
  }
  return sum;
}

/**
 * The Workspace's learning records due for expiry, and passes past its window (`cutoff`; null:
 * kept forever, so only the expiries run). Called by the nightly retention pass for every team.
 */
export async function sweepMemoryLearning(
  db: KaijuDb,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<LearningPurgeCounts> {
  const { stop } = options;
  let sum = await repeat(db, teamId, stop, (tx) => expireCandidates(tx, teamId));
  sum = add(sum, await repeat(db, teamId, stop, (tx) => expireProposals(tx, teamId)));
  sum = add(sum, await repeat(db, teamId, stop, (tx) => expireSuggestions(tx, teamId)));
  if (cutoff !== null) {
    sum = add(sum, await repeat(db, teamId, stop, (tx) => purgePasses(tx, teamId, cutoff)));
    sum = add(sum, await repeat(db, teamId, stop, (tx) => purgeDecided(tx, teamId, cutoff)));
  }
  return sum;
}

/**
 * Offboarding step (inside the caller's guarded team transaction, after its hold check): what a
 * departed member left in the Workspace's learning records, 30 days after they left: their passes
 * (with the candidates and usage record), dismissals and watermarks, the proposals and project
 * suggestions they made in any state, and the reminders and notices about those. A Workspace
 * memory a curator approved from their proposal stays, as every Workspace memory does ("former
 * member"); the conversations follow thread retention. Nothing when the person is an active
 * member again or a hold covers them. Always audited.
 */
export async function purgeDepartedLearningInTx(
  tx: KaijuTx,
  teamId: string,
  userId: string,
): Promise<LearningPurgeCounts> {
  await lockLegalHolds(tx);
  const gate = await tx.execute<{ ok: boolean }>(sql`
    SELECT (NOT ${activeMember(teamId, userId)}
            AND NOT public.legal_hold_covers(${teamId}, ${userId})) AS ok`);
  if (gate.rows[0]?.ok !== true) {
    await audited(tx, teamId, "offboarding", NO_LEARNING_PURGE, userId);
    return NO_LEARNING_PURGE;
  }
  const objects = sql`(
    SELECT id FROM memory_proposals WHERE team_id = ${teamId} AND proposer_id = ${userId}
    UNION ALL
    SELECT id FROM memory_project_suggestions WHERE team_id = ${teamId} AND suggested_by = ${userId}
    UNION ALL
    SELECT id FROM memory_learning_passes WHERE team_id = ${teamId} AND user_id = ${userId})`;
  await tx.execute(sql`
    DELETE FROM memory_reminders WHERE team_id = ${teamId} AND object_id IN ${objects}`);
  await tx.execute(sql`
    DELETE FROM notifications WHERE team_id = ${teamId} AND memory_object_id IN ${objects}`);
  const deleted = async (statement: ReturnType<typeof sql>) =>
    (await tx.execute(statement)).rowCount ?? 0;
  const proposals = await deleted(sql`
    DELETE FROM memory_proposals WHERE team_id = ${teamId} AND proposer_id = ${userId}`);
  const suggestions = await deleted(sql`
    DELETE FROM memory_project_suggestions WHERE team_id = ${teamId} AND suggested_by = ${userId}`);
  const res = await tx.execute<{ passes: number; candidates: number }>(sql`
    WITH counted AS (
      SELECT count(*)::int AS n FROM memory_candidates c
        JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
       WHERE c.team_id = ${teamId} AND p.user_id = ${userId}),
    gone AS (
      DELETE FROM memory_learning_passes
       WHERE team_id = ${teamId} AND user_id = ${userId} RETURNING id)
    SELECT (SELECT count(*) FROM gone)::int AS passes, (SELECT n FROM counted) AS candidates`);
  const dismissals = await deleted(sql`
    DELETE FROM memory_dismissals WHERE team_id = ${teamId} AND user_id = ${userId}`);
  const watermarks = await deleted(sql`
    DELETE FROM memory_learning_watermarks WHERE team_id = ${teamId} AND user_id = ${userId}`);
  const counts: LearningPurgeCounts = {
    ...NO_LEARNING_PURGE,
    passes: res.rows[0]?.passes ?? 0,
    candidates: res.rows[0]?.candidates ?? 0,
    dismissals,
    watermarks,
    proposals,
    suggestions,
  };
  await audited(tx, teamId, "offboarding", counts, userId);
  return counts;
}
