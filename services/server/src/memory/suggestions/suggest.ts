import { z } from "zod";
import { semanticMemoryKindSchema, semanticMemoryStatementSchema } from "@kobe/protocol";
import {
  MEMORY_SUGGESTION_EVIDENCE_MAX,
  SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { notifyMemory, registerMemoryReminder } from "../../notifications/memory.js";
import { MemoryItemError, inactive, notAllowed } from "../items/errors.js";
import type { MemoryWho } from "../items/who.js";
import { workspaceOf } from "../review/ids.js";
import { DISABLED_REASON, scanSharedLine, threadProject } from "../review/notes-target.js";
import { settleWhenDecided } from "../review/notify.js";
import { decideCandidate, lockCandidate, type StoredCandidate } from "../review/stored.js";
import { scopeEnabled } from "../switches.js";
import { decidersOf, type SuggestionEvidence } from "./rows.js";

/**
 * Suggest to editors (KOBE-652, SM7/Q2): in a project thread a project **reader** can't write the
 * project's Notes, so their To review candidate becomes a suggestion for the project's editors,
 * owners and Team admins. One `withTeam()` transaction: the candidate is the caller's own, open
 * and unexpired (`lockCandidate`); the thread's project is read now and the caller is a reader of
 * it (editors add it themselves); project memory is on; the statement passes the shared-text scan
 * of Add to project notes (secrets and instruction lint refuse); the evidence keeps only quotes of
 * the caller's own messages in the thread (at least one, else refused). The candidate is decided
 * (`suggested`), the deciders are notified and owe a reminder after 7 days. Interactive only: the
 * route refuses agent calls.
 */

export const suggestSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
});
export type SuggestBody = z.infer<typeof suggestSchema>;

export const NEEDS_OWN_WORDS = "A suggestion needs your own words in this conversation.";

/** The candidate's quotes that come from the person's own messages in the thread, capped. */
async function ownQuotes(
  tx: KobeTx,
  ids: { teamId: string; threadId: string },
  c: StoredCandidate,
): Promise<SuggestionEvidence> {
  const entryIds = [...new Set(c.evidence.map((e) => e.entry_id))];
  const { rows } = await tx.execute<{ entry_id: string }>(sql`
    SELECT entry_id FROM thread_entries
     WHERE team_id = ${ids.teamId} AND thread_id = ${ids.threadId} AND type = 'message'
       AND payload -> 'message' ->> 'role' = 'user'
       AND entry_id IN (${sql.join(
         entryIds.map((id) => sql`${id}`),
         sql`, `,
       )})`);
  const own = new Set(rows.map((r) => r.entry_id));
  const kept: SuggestionEvidence = [];
  for (const e of c.evidence) {
    if (!own.has(e.entry_id) || kept.length >= MEMORY_SUGGESTION_EVIDENCE_MAX) continue;
    const next = [...kept, { entry_id: e.entry_id, quote: e.quote }];
    if (Buffer.byteLength(JSON.stringify(next)) > SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES) break;
    kept.push(next[next.length - 1] as SuggestionEvidence[number]);
  }
  return kept;
}

export interface Suggested {
  readonly suggestion_id: string;
  readonly candidate_id: string;
  readonly project_id: string;
  readonly state: "pending";
  readonly expires_at: string;
  /** The quotes the editors see (the person's own messages only). */
  readonly evidence: SuggestionEvidence;
}

export function suggestToEditors(
  db: KobeDb,
  who: MemoryWho,
  candidateId: string,
  body: SuggestBody,
): Promise<Suggested> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    const ids = { teamId, userId: who.userId, threadId: row.threadId };
    const project = await threadProject(tx, ids);
    if (!project) throw inactive("This conversation is no longer in a project you can see.");
    if (project.access === "write")
      throw notAllowed("You can add it to the project's notes yourself.");
    if (!(await scopeEnabled(tx, teamId, "project")))
      throw new MemoryItemError("memory_disabled", DISABLED_REASON);
    const statement = (body.statement ?? row.candidate.statement).replace(/\s+/g, " ").trim();
    const kind = body.kind ?? row.candidate.kind;
    scanSharedLine(statement);
    const evidence = await ownQuotes(tx, ids, row.candidate);
    if (evidence.length === 0) throw notAllowed(NEEDS_OWN_WORDS);

    const { rows } = await tx.execute<{ id: string; expires_at: string | Date }>(sql`
      INSERT INTO memory_project_suggestions (team_id, project_id, thread_id, candidate_ref,
                                              statement, kind, evidence, suggested_by)
      VALUES (${teamId}, ${project.projectId}, ${row.threadId}, ${row.id}, ${statement}, ${kind},
              ${JSON.stringify(evidence)}::jsonb, ${who.userId})
      RETURNING id, expires_at`);
    const inserted = rows[0];
    if (!inserted) throw new Error("suggestion insert returned nothing");
    await decideCandidate(tx, teamId, row.id, "suggested", {
      op: "suggested",
      suggestion_id: inserted.id,
      project_id: project.projectId,
      batch: false,
    });
    await recordAudit(tx, {
      action: "memory.suggestion.created",
      teamId,
      target: {
        suggestionId: inserted.id,
        candidateId: row.id,
        passId: row.passId,
        threadId: row.threadId,
        projectId: project.projectId,
        edited: statement !== row.candidate.statement || kind !== row.candidate.kind,
      },
    });
    await settleWhenDecided(tx, teamId, row.passId);
    const recipients = (await decidersOf(tx, teamId, project.projectId)).filter(
      (u) => u !== who.userId,
    );
    await registerMemoryReminder(tx, teamId, {
      objectId: inserted.id,
      about: "memory.suggestion.received",
      projectId: project.projectId,
      recipients,
    });
    // Last: notifyMemory holds each recipient's digest lock until commit.
    await notifyMemory(tx, teamId, recipients, {
      kind: "memory.suggestion.received",
      objectId: inserted.id,
      projectId: project.projectId,
      actorUserId: who.userId,
    });
    return {
      suggestion_id: inserted.id,
      candidate_id: row.id,
      project_id: project.projectId,
      state: "pending",
      expires_at: new Date(inserted.expires_at).toISOString(),
      evidence,
    };
  });
}
