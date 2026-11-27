import { sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import {
  NOTEBOOK_HISTORY_MAX,
  notebookFinishedPayloadSchema,
  notebookStartedPayloadSchema,
  type ActorContext,
  type NotebookExecOutputsResponse,
  type NotebookHistoryEntry,
  type NotebookHistoryResponse,
} from "@kaiju/protocol";
import { RunError } from "../runs/errors.js";
import { findThread } from "../threads/repository.js";
import { viewerProjectIds } from "../threads/references.js";
import { readOutputs } from "./execution.js";
import { uuidArray } from "../retention/purge.js";

/**
 * The run pane's Log after a reload (KOBE-804): a file's past executions in a thread, read from
 * the run events already stored for it (`notebook.started` / `notebook.finished`, the member's
 * runs and the agent's `run_python` alike), kept until D18 compacts a run 7 days after it ended.
 * Nothing new is stored, and variable values are never part of it. The thread's owner only (the
 * kernel is theirs): a shared reader is 403 `read_only`, anyone else 404. Bounded: the newest
 * {@link NOTEBOOK_HISTORY_MAX} executions, without outputs; one execution's outputs are read on
 * their own (at most the run's cap, 200 outputs and 2 MB).
 */

async function assertOwner(tx: KaijuTx, actor: ActorContext, threadId: string): Promise<void> {
  const viewer = {
    teamId: actor.team_id,
    userId: actor.user_id,
    projectIds: await viewerProjectIds(tx, actor.team_id, actor.user_id),
  };
  const found = await findThread(tx, viewer, threadId);
  if (!found) throw new RunError("thread_not_found");
  if (found.access !== "owner") throw new RunError("read_only");
}

export async function fileHistory(
  db: KaijuDb,
  actor: ActorContext,
  threadId: string,
  path: string,
): Promise<NotebookHistoryResponse> {
  const teamId = actor.team_id;
  return withTeam(db, teamId, async (tx) => {
    await assertOwner(tx, actor, threadId);
    return { executions: await fileExecutions(tx, teamId, threadId, path, NOTEBOOK_HISTORY_MAX) };
  });
}

/**
 * A `.py` file's newest `limit` executions in a thread, newest first, without outputs (inside the
 * caller's team transaction; the caller has checked who may read them). Also the agent's
 * `editor_read` (KOBE-848), whose run is the thread owner's.
 */
export async function fileExecutions(
  tx: KaijuTx,
  teamId: string,
  threadId: string,
  path: string,
  limit: number,
): Promise<NotebookHistoryEntry[]> {
  const started = await tx.execute<{
    run_id: string;
    payload: unknown;
    created_at: Date;
    ended: boolean;
  }>(sql`
    SELECT e.run_id, e.payload, e.created_at, r.ended_at IS NOT NULL AS ended
      FROM run_events e
      JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
     WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${threadId}
       AND e.type = 'notebook.started'
       AND e.payload->>'path' = ${path} AND NOT (e.payload ? 'cell_id')
     ORDER BY e.created_at DESC, e.seq DESC
     LIMIT ${limit}`);
  const entries: Omit<NotebookHistoryEntry, "finished">[] = [];
  for (const row of started.rows) {
    const payload = notebookStartedPayloadSchema.safeParse(row.payload);
    if (!payload.success) continue;
    entries.push({
      run_id: row.run_id,
      run_ended: row.ended,
      started_at: new Date(row.created_at).toISOString(),
      started: payload.data,
    });
  }
  if (entries.length === 0) return [];
  const finished = await tx.execute<{ payload: unknown }>(sql`
    SELECT e.payload FROM run_events e
     WHERE e.team_id = ${teamId}
       AND e.run_id = ANY(${uuidArray([...new Set(entries.map((e) => e.run_id))])})
       AND e.type = 'notebook.finished'`);
  const ends = new Map<string, NotebookHistoryEntry["finished"]>();
  for (const row of finished.rows) {
    const payload = notebookFinishedPayloadSchema.safeParse(row.payload);
    if (payload.success) ends.set(payload.data.exec_id, payload.data);
  }
  return entries.map((e) => ({ ...e, finished: ends.get(e.started.exec_id) ?? null }));
}

export async function execOutputs(
  db: KaijuDb,
  actor: ActorContext,
  threadId: string,
  execId: string,
): Promise<NotebookExecOutputsResponse> {
  const teamId = actor.team_id;
  const runId = await withTeam(db, teamId, async (tx) => {
    await assertOwner(tx, actor, threadId);
    const found = await tx.execute<{ run_id: string }>(sql`
      SELECT e.run_id
        FROM run_events e
        JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
       WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${threadId}
         AND e.type = 'notebook.started' AND e.payload->>'exec_id' = ${execId}
       LIMIT 1`);
    return found.rows[0]?.run_id;
  });
  if (runId === undefined) throw new RunError("run_not_found", "No execution with that id.");
  return { outputs: await readOutputs(db, teamId, runId, execId) };
}
