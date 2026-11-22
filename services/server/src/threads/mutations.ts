import { endThreadRules } from "../policy/user-rules.js";
import {
  ACTIVE_RUN_STATUSES,
  and,
  eq,
  runs,
  sql,
  threadEntries,
  threads,
  type KobeTx,
  type RunStatus,
} from "@kobe/db";
import type { ThreadSummary, UpdateThreadBody } from "./schemas.js";
import { recordAudit } from "../audit/record.js";
import { resolveSwitchPin, type AgentPin, type DraftPin } from "../agents/versions.js";
import { visibilityOf } from "./share.js";
import { applyShareScope, recordShareScope, shareScopeRefusal } from "./share-scope.js";
import { notifyThreadAccess } from "../event-stream/access.js";
import type { ThinkingLevel, ThreadVisibility } from "@kobe/protocol";
import { isSkippedSummaryEntry } from "../policy/skipped-summary.js";
import { isModelEnabled } from "../models/team-store.js";
import {
  findThread,
  hasRunIn,
  summarizeOne,
  summaryColumns,
  THREAD_LOCK_TIMEOUT,
  toSummary,
  TRASH_INTERVAL,
  type SummaryRow,
  type ThreadError,
  type ThreadResult,
  type Viewer,
} from "./queries.js";

/**
 * Thread changes (spec D9, D15, D18, D19, §6.1): create, the owner's changes, branch and agent
 * switches, Trash and restore. Each runs inside the caller's `withTeam` transaction and, apart
 * from create, locks the thread row first (`lockForChange`); see `queries.ts` for the visibility
 * rules.
 */

export async function createThread(
  tx: KobeTx,
  input: {
    teamId: string;
    ownerUserId: string;
    projectId: string | null;
    /** A pre-chosen id (a fork copies blobs into the new thread's tree first); default: random. */
    id?: string;
    /**
     * The published agent version the thread pins (D19); null = the site default agent. A
     * `DraftPin` (no version) makes it a builder test thread (KOBE-85): pass `isTest`.
     */
    agent: AgentPin | DraftPin | null;
    isTest?: boolean;
    /** A Workbench test chat's draft (KOBE-323): the caller checked the creator can see it. */
    skillDraftId?: string;
    /** The schedule that started the thread (KOBE-174): it sits in the user's Scheduled folder. */
    scheduleId?: string;
    /** A skill eval execution's thread (KOBE-325): run by the eval runner, never listed. */
    skillEvalRunId?: string;
    title: string | null;
    /** The thread's model alias (KOBE-44); the caller checked the team enabled it. */
    modelAlias?: string | null;
    /** The conversation's thinking level (KOBE-260); clamped when each run starts. */
    thinkingLevel?: ThinkingLevel | null;
    /**
     * A fork's provenance (CE16): its source and the entry it was taken at. Set here only: the
     * link is never updated afterwards (trigger `threads_guard_forked_from`, KOBE-215).
     */
    forkedFrom?: { readonly threadId: string; readonly entryId: string };
    /** The team folder to start in (KOBE-534, TF9: a fork starts in its source's folder). */
    folderId?: string | null;
  },
): Promise<ThreadSummary> {
  const { agent, modelAlias, isTest, forkedFrom, folderId, skillDraftId, skillEvalRunId, ...rest } =
    input;
  const [row] = await tx
    .insert(threads)
    .values({
      ...rest,
      forkedFromThreadId: forkedFrom?.threadId ?? null,
      forkedAtEntryId: forkedFrom?.entryId ?? null,
      folderId: folderId ?? null,
      modelAlias: modelAlias ?? null,
      isTest: isTest ?? false,
      skillTest: skillDraftId !== undefined,
      skillDraftId: skillDraftId ?? null,
      skillEval: skillEvalRunId !== undefined,
      skillEvalRunId: skillEvalRunId ?? null,
      agentScope: agent?.agentScope ?? null,
      agentId: agent?.agentId ?? null,
      agentVersion: agent?.agentVersion ?? null,
    })
    .returning(summaryColumns);
  if (!row) throw new Error("thread insert returned no row");
  return toSummary(row);
}

/** Locks the thread for a change by its owner, or says why the viewer can't change it. */
export async function lockForChange(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<{ ok: true; thread: SummaryRow } | { ok: false; error: ThreadError }> {
  // Transaction-local: fail fast (55P03) rather than queue behind a long-held row lock.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${THREAD_LOCK_TIMEOUT}'`));
  const found = await findThread(tx, viewer, id, { lock: true });
  if (!found) return { ok: false, error: "thread_not_found" };
  if (found.access !== "owner") return { ok: false, error: "read_only" };
  return { ok: true, thread: found.thread };
}

/**
 * Locks the thread for filing in a folder (KOBE-534, TF3): unlike {@link lockForChange}, a reader
 * under D23/CE20 may file too (folders are the team's, and a shared thread is already in front of
 * them), so the row is locked whenever the viewer may read it. Every other change stays
 * owner-only. A reader never reaches a thread in Trash (not readable: 404).
 */
export async function lockForFiling(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<{ ok: true; thread: SummaryRow } | { ok: false; error: ThreadError }> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${THREAD_LOCK_TIMEOUT}'`));
  const found = await findThread(tx, viewer, id, { lock: true });
  if (!found) return { ok: false, error: "thread_not_found" };
  return { ok: true, thread: found.thread };
}

/**
 * The owner's changes to a thread: title, model and share scope. `visibility` (`POST /share`) sets
 * the scope; the older `shared_to_project` (PATCH) shares to the project (true) or ends a project
 * share (false; a team share stays).
 */
export async function updateThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  body: UpdateThreadBody & { readonly visibility?: ThreadVisibility },
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  const before = locked.thread;
  if (before.deletedAt) return { ok: false, error: "thread_in_trash" };
  // PATCH shared_to_project (KOBE-34) is about the project: refused outside one, as before.
  if (body.shared_to_project !== undefined && before.projectId === null) {
    return { ok: false, error: "not_in_project" };
  }
  const target = targetScope(before, body);
  if (target !== undefined) {
    const refusal = await shareScopeRefusal(tx, viewer, before, target);
    if (refusal) return { ok: false, error: refusal };
  }
  // A newly chosen model must be one the team enabled; keeping the current one is always fine.
  const modelChanged = body.model !== undefined && body.model !== before.modelAlias;
  if (modelChanged && body.model && !(await isModelEnabled(tx, viewer.teamId, body.model))) {
    return { ok: false, error: "model_not_enabled" };
  }
  const set = {
    // The owner's own name locks the title against auto-titling (CE18, KOBE-292), and
    // clearing it hands the name back to auto-titling.
    ...(body.title !== undefined ? { title: body.title, titleLocked: body.title !== null } : {}),
    ...applyShareScope(before, target),
    ...(modelChanged ? { modelAlias: body.model ?? null } : {}),
    // KOBE-260: any level may be chosen; each run clamps it to the site and team settings.
    ...(body.thinking_level !== undefined && body.thinking_level !== (before.thinkingLevel ?? null)
      ? { thinkingLevel: body.thinking_level }
      : {}),
  };
  // Nothing changes (the scope it already has, the same model): idempotent, nothing recorded.
  if (Object.keys(set).length === 0) {
    return { ok: true, thread: await summarizeOne(tx, viewer, before) };
  }
  const [row] = await tx
    .update(threads)
    .set(set)
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordShareScope(tx, viewer, before, row);
  if (modelChanged) {
    await recordAudit(tx, {
      action: "thread.model_changed",
      teamId: viewer.teamId,
      target: { threadId: id, from: before.modelAlias, to: row.modelAlias },
    });
  }
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/** The scope a change asks for, or undefined when it leaves the scope alone. */
function targetScope(
  thread: SummaryRow,
  body: {
    readonly visibility?: ThreadVisibility | undefined;
    readonly shared_to_project?: boolean | undefined;
  },
): ThreadVisibility | undefined {
  if (body.visibility !== undefined) return body.visibility;
  if (body.shared_to_project === undefined) return undefined;
  if (body.shared_to_project) return "project";
  return visibilityOf(thread) === "project" ? "private" : undefined;
}

/** A run that holds the thread or will (queued). */
export const PENDING_RUN_STATUSES: readonly RunStatus[] = ["queued", ...ACTIVE_RUN_STATUSES];

/**
 * Switches the active branch (§6.1 `POST /v1/threads/{id}/leaf`, D15). Refused while a run holds
 * the thread: Pi continues from its own leaf and would diverge from the record; and while one is
 * queued (CT3, Q7): the leaf never moves under a queued prompt.
 */
export async function setLeaf(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  entryId: string,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES))
    return { ok: false, error: "thread_busy" };
  const [entry] = await tx
    .select({ entryId: threadEntries.entryId })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, viewer.teamId),
        eq(threadEntries.threadId, id),
        eq(threadEntries.entryId, entryId),
      ),
    );
  // The skipped-actions note is not in Pi's session: it can't be where Pi continues from.
  if (!entry || (await isSkippedSummaryEntry(tx, viewer.teamId, id, entryId))) {
    return { ok: false, error: "entry_not_found" };
  }
  const [row] = await tx
    .update(threads)
    .set({ leafEntryId: entryId })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/**
 * Pins another published version of the thread's agent (D19 one-click switch; default: the
 * agent's current version). Owner only, like every change. Refused while a run is active (the run
 * started on the old version); queued runs resolve the pin when they start (KOBE-47). The agent
 * must still be available to the owner (not suspended or archived).
 */
export async function switchAgentVersion(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  version: number | undefined,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (thread.agentId === null || thread.agentVersion === null || thread.agentScope === null) {
    return { ok: false, error: "no_agent" };
  }
  if (await hasRunIn(tx, viewer, id, ACTIVE_RUN_STATUSES)) {
    return { ok: false, error: "thread_busy" };
  }
  const pin = await resolveSwitchPin(
    tx,
    viewer,
    { agentScope: thread.agentScope, agentId: thread.agentId },
    version,
  );
  if (!pin.ok) return pin;
  if (pin.value.agentVersion === thread.agentVersion)
    return { ok: true, thread: await summarizeOne(tx, viewer, thread) };
  const [row] = await tx
    .update(threads)
    .set({ agentVersion: pin.value.agentVersion })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordAudit(tx, {
    action: "thread.agent_switched",
    teamId: viewer.teamId,
    target: {
      threadId: id,
      agentId: thread.agentId,
      scope: thread.agentScope,
      fromVersion: thread.agentVersion,
      toVersion: pin.value.agentVersion,
    },
  });
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/**
 * Moves the thread to Trash (D18 soft delete). Refused while it has an active or queued run: Stop
 * and clear queued messages first, so nothing runs on a thread its owner deleted. Idempotent.
 */
export async function trashThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt)
    return { ok: true, thread: await summarizeOne(tx, viewer, locked.thread) };
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES))
    return { ok: false, error: "thread_busy" };
  const [row] = await tx
    .update(threads)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  // Trash ends the thread's remembered approvals for good: a restore doesn't bring them back.
  await endThreadRules(tx, viewer.teamId, [id]);
  await recordAudit(tx, {
    action: "thread.trashed",
    teamId: viewer.teamId,
    target: { threadId: id },
  });
  // Readers lose a shared thread while it is in Trash: their open streams recheck now.
  if (visibilityOf(row) !== "private") await notifyThreadAccess(tx, viewer.teamId, id);
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/** Restores a thread from Trash within the 30-day window; past it the thread awaits purge. */
export async function restoreThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (!locked.thread.deletedAt) return { ok: false, error: "not_in_trash" };
  const [row] = await tx
    // Restoring counts as activity: the retention period runs again from now (KOBE-18 review H1),
    // so a thread restored near the end of its period isn't purged the next night.
    .update(threads)
    .set({ deletedAt: null, lastActivityAt: sql`now()` })
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.id, id),
        sql`${threads.deletedAt} > now() - ${TRASH_INTERVAL}`,
      ),
    )
    .returning(summaryColumns);
  if (!row) return { ok: false, error: "thread_not_found" };
  await recordAudit(tx, {
    action: "thread.restored",
    teamId: viewer.teamId,
    target: { threadId: id },
  });
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/**
 * Clears the viewer's own test threads (KOBE-85), all or those of one agent: moves them to Trash
 * (soft delete, so their runs and `run_usage` stay for budgets; Trash lists never show them and
 * the retention purge removes them later). Threads with an active or queued run are skipped
 * (stop them first). Not audited: they are throwaway, and nothing is shared. Returns the count.
 */
export async function clearTestThreads(
  tx: KobeTx,
  viewer: Viewer,
  options: { agentId?: string | undefined },
): Promise<number> {
  const busy = sql`EXISTS (SELECT 1 FROM ${runs} r WHERE r.team_id = ${threads.teamId}
    AND r.thread_id = ${threads.id} AND r.status IN ('queued', 'running', 'waiting_approval'))`;
  const rows = await tx
    .update(threads)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        eq(threads.isTest, true),
        sql`${threads.deletedAt} IS NULL`,
        options.agentId === undefined ? undefined : eq(threads.agentId, options.agentId),
        sql`NOT ${busy}`,
      ),
    )
    .returning({ id: threads.id });
  await endThreadRules(
    tx,
    viewer.teamId,
    rows.map((r) => r.id),
  );
  return rows.length;
}
