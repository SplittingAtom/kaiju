import {
  checkRetry,
  imitatesAppContext,
  imitatesSkillRequest,
  nextThreadStatus,
  splitAppContext,
  splitItemReferences,
  splitSkillRequest,
  withItemReferences,
  withSkillRequest,
  type ActorContext,
  type SubmitMessageResult,
  type UpdateQueuedBody,
} from "@kaiju/protocol";
import { RUN_INPUT_MAX_CHARS, sql, type AuditActor } from "@kaiju/db";
import { recordAudit } from "../../audit/record.js";
import { readApprovalFloor } from "../../policy/approval-floor.js";
import { clampApprovalMode } from "../../sandbox-wire/policy-check.js";
import { lockOwnedThread, ownedRun } from "../access.js";
import { RunError } from "../errors.js";
import { promoteInTx } from "../lifecycle.js";
import { rewriteMentions } from "../mentions.js";
import { queuedMessageCount, reorderQueuedRuns } from "../queue-order.js";
import {
  existingRetry,
  insertQueuedRun,
  isQueuePaused,
  retryBranchPoint,
  retryCandidates,
  setQueuePaused,
  setThreadStatus,
  touchThread,
} from "../store.js";
import type { RunCore } from "./core.js";
import { ownerOf, retryViewing } from "./submit.js";

export const userActor = (actor: ActorContext): AuditActor => ({ kind: "user", id: actor.user_id });

/** The owner edits a queued message's own text; its app context, skill and references stay. */
export async function updateQueued(
  core: RunCore,
  actor: ActorContext,
  runId: string,
  body: UpdateQueuedBody,
): Promise<void> {
  await core.threadTx(actor, async (tx, viewer) => {
    const { thread, run } = await ownedRun(tx, viewer, runId, true);
    if (run.status !== "queued") {
      throw new RunError("invalid_transition", "Only queued messages can be edited.");
    }
    if (imitatesAppContext(body.content) || imitatesSkillRequest(body.content)) {
      throw new RunError("invalid_content");
    }
    const { text } = await rewriteMentions(
      tx,
      ownerOf(actor.team_id, thread),
      body.content,
      body.mentions ?? [],
    );
    // An edit changes the member's text only; the app context sent with it stays (LOW-E).
    const before = await tx.execute<{ input: string }>(sql`
      SELECT input FROM runs WHERE team_id = ${actor.team_id} AND id = ${runId}`);
    const old = before.rows[0]?.input ?? "";
    const kept = splitAppContext(old);
    // ... and so does the skill picked for it (KOBE-451).
    const skill = splitSkillRequest(kept.rest).skill;
    // ... and so do the app items it references (KOBE-490): any references line in the new
    // text is dropped first, so an edit never repeats it (idempotent; review MEDIUM-2).
    const withRefs = withItemReferences(
      splitItemReferences(kept.rest).references,
      splitItemReferences(text).rest,
    );
    const own = skill === null ? withRefs : withSkillRequest(skill, withRefs);
    const input = kept.contexts.length > 0 ? old.slice(0, kept.restAt) + own : own;
    if (input.length > RUN_INPUT_MAX_CHARS) throw new RunError("message_too_large");
    await tx.execute(sql`
      UPDATE runs SET input = ${input} WHERE team_id = ${actor.team_id} AND id = ${runId}`);
    await touchThread(tx, actor.team_id, run.threadId);
  });
}

export async function retry(
  core: RunCore,
  actor: ActorContext,
  runId: string,
): Promise<SubmitMessageResult> {
  core.requireIsolation();
  const teamId = actor.team_id;
  const viewing = await retryViewing(core, actor, runId);
  const out = await core.threadTx(actor, async (tx, viewer) => {
    const { thread, run } = await ownedRun(tx, viewer, runId, true);
    if (thread.deletedAt !== null) throw new RunError("thread_in_trash");
    await core.assertMayRun(tx, actor);
    const check = checkRetry(await retryCandidates(tx, teamId, thread.id), runId);
    if (check === "already_retried") {
      return { ...(await existingRetry(tx, teamId, runId)), promotion: undefined };
    }
    if (check === "not_interrupted") {
      throw new RunError("invalid_transition", "Only interrupted runs can be retried.");
    }
    if (check === "not_latest") {
      throw new RunError("invalid_transition", "Only the thread's latest run can be retried.");
    }
    // Retry resolves the interrupted state (D14); after "Continue without retry" it is gone.
    if (thread.status !== "interrupted") {
      throw new RunError(
        "invalid_transition",
        "Retry is only offered while the thread is interrupted.",
      );
    }
    const id = await insertQueuedRun(tx, {
      teamId,
      threadId: thread.id,
      trigger: run.trigger,
      // Re-clamped: a floor raised since the original run applies to its retry.
      approvalMode: clampApprovalMode(run.approvalMode, await readApprovalFloor(tx)),
      input: run.input,
      // Same branch point as the original: the retry is a sibling branch; history stays intact.
      parentEntryId: await retryBranchPoint(tx, teamId, run),
      retryOfRunId: runId,
      clientKey: null,
      // The file the member had open with the original, read again (KOBE-462 FE7).
      viewing: viewing ?? null,
    });
    await touchThread(tx, teamId, thread.id);
    const { promotion, queued } = await core.promoteOrQueue(tx, teamId, thread.id, id);
    await recordAudit(tx, {
      action: "run.retried",
      actor: userActor(actor),
      teamId,
      target: { runId: id, threadId: thread.id, retryOfRunId: runId },
    });
    return { runId: id, queued, promotion };
  });
  if (out.promotion) core.afterCommit(teamId, out.promotion);
  return { run_id: out.runId, queued: out.queued };
}

export async function resumeQueue(
  core: RunCore,
  actor: ActorContext,
  threadId: string,
): Promise<void> {
  const promotion = await core.threadTx(actor, async (tx, viewer) => {
    const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    const paused = await isQueuePaused(tx, actor.team_id, thread.id);
    if (thread.status !== "interrupted" && !paused) return undefined;
    if (paused) await setQueuePaused(tx, actor.team_id, thread.id, false);
    await touchThread(tx, actor.team_id, thread.id);
    await recordAudit(tx, {
      action: "run.queue_resumed",
      actor: userActor(actor),
      teamId: actor.team_id,
      target: { threadId: thread.id, wasInterrupted: thread.status === "interrupted" },
    });
    await setThreadStatus(
      tx,
      actor.team_id,
      thread.id,
      nextThreadStatus(thread.status, { kind: "queue_resumed" }),
    );
    return promoteInTx(tx, core.agents, actor.team_id, thread.id, core.hold);
  });
  if (promotion) core.afterCommit(actor.team_id, promotion);
}

export async function reorderQueue(
  core: RunCore,
  actor: ActorContext,
  threadId: string,
  runIds: readonly string[],
): Promise<void> {
  await core.threadTx(actor, async (tx, viewer) => {
    const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    await reorderQueuedRuns(tx, actor.team_id, thread.id, runIds);
    await touchThread(tx, actor.team_id, thread.id);
    await recordAudit(tx, {
      action: "run.queue_reordered",
      actor: userActor(actor),
      teamId: actor.team_id,
      target: { threadId: thread.id, queued: runIds.length },
    });
  });
}

export async function pauseQueue(
  core: RunCore,
  actor: ActorContext,
  threadId: string,
): Promise<void> {
  await core.threadTx(actor, async (tx, viewer) => {
    const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    // A queued Retry still runs first while paused (D14, promotion): only messages wait.
    const waiting = await queuedMessageCount(tx, actor.team_id, thread.id);
    if (waiting === 0 || (await isQueuePaused(tx, actor.team_id, thread.id))) return;
    await setQueuePaused(tx, actor.team_id, thread.id, true);
    // Like every other queue change: the thread's activity moves, so other tabs read it again.
    await touchThread(tx, actor.team_id, thread.id);
    await recordAudit(tx, {
      action: "run.queue_paused",
      actor: userActor(actor),
      teamId: actor.team_id,
      target: { threadId: thread.id, queued: waiting },
    });
  });
}
