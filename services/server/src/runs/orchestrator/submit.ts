import {
  imitatesAppContext,
  imitatesSkillRequest,
  withItemReferences,
  withSkillRequest,
  type ActorContext,
  type ApprovalMode,
  type SubmitMessageCommand,
  type SubmitMessageResult,
} from "@kaiju/protocol";
import { RUN_INPUT_MAX_CHARS, type KaijuTx } from "@kaiju/db";
import {
  resolveAppContexts,
  withAppContext,
  type ResolvedAppContext,
} from "../../apps/context-block.js";
import { connectorsOffIn } from "../../connectors/thread-connectors.js";
import { readApprovalFloor } from "../../policy/approval-floor.js";
import { isSkippedSummaryEntry } from "../../policy/skipped-summary.js";
import { clampApprovalMode } from "../../sandbox-wire/policy-check.js";
import { findThread } from "../../threads/repository.js";
import type { StagedFile } from "../../uploads/attach.js";
import { isInternalPath } from "../../workspace-files/paths.js";
import { lockOwnedThread, ownedRun } from "../access.js";
import { effectiveSkillNames } from "../effective-skills.js";
import { RunError } from "../errors.js";
import { failedEvent } from "../lifecycle.js";
import { checkMentionPaths, rewriteMentions } from "../mentions.js";
import type { ScheduledSubmit } from "../scheduled-submit.js";
import {
  applyTransition,
  entryExists,
  getRunRow,
  insertQueuedRun,
  promptViewingPath,
  queuedCount,
  runByClientKey,
  runViewingPath,
  setQueuePaused,
  touchThread,
  type StoredViewing,
} from "../store.js";
import type { RunCore } from "./core.js";

/** Uploads staged for a message, between validation and the submit transaction (KOBE-144). */
interface StagedAttachments {
  readonly owner: { readonly teamId: string; readonly userId: string };
  readonly caller: { readonly teamId: string; readonly userId: string };
  readonly staged: readonly StagedFile[];
}

export interface SubmitOptions {
  readonly clientKey?: string;
  readonly scheduled?: ScheduledSubmit;
}

/** The workspace a thread's runs use: its owner's, in its team (D11). */
export const ownerOf = (teamId: string, thread: { readonly ownerUserId: string }) => ({
  teamId,
  userId: thread.ownerUserId,
});

export async function submitMessage(
  core: RunCore,
  actor: ActorContext,
  command: SubmitMessageCommand,
  options: SubmitOptions = {},
): Promise<SubmitMessageResult> {
  core.requireIsolation();
  // A member's mentions are checked before any upload is staged (KOBE-223 N1).
  if (command.trigger === "user") checkMentionPaths(command.mentions ?? []);
  // Only the server writes app context (KOBE-439 review LOW-E): a member's text that imitates
  // it would show as a chip in history and could be mistaken for an app's data.
  if (
    command.trigger === "user" &&
    (imitatesAppContext(command.content) || imitatesSkillRequest(command.content))
  ) {
    throw new RunError("invalid_content");
  }
  // MCP Apps context chips (KOBE-439): only apps the member can open now, same template.
  const appContext = await resolveAppContexts(
    core.db,
    actor.team_id,
    actor.user_id,
    command.trigger === "user" ? (command.app_context ?? []) : [],
  );
  if (appContext === undefined) throw new RunError("app_context_invalid");
  const viewing = await readViewing(core, actor, command);
  const withViewing = viewing === undefined ? command : { ...command, resolvedViewing: viewing };
  const fileIds = command.file_ids ?? [];
  const stager = core.workspace.attachments();
  if (fileIds.length > 0 && stager === undefined) {
    throw new RunError("attachments_unavailable");
  }
  const clientKey = options.clientKey ?? null;
  const attach =
    fileIds.length > 0 ? await stageAttachments(core, actor, command, clientKey) : undefined;
  if (attach === undefined) {
    return submitInTx(
      core,
      actor,
      withViewing,
      clientKey,
      undefined,
      () => {},
      options.scheduled,
      appContext,
    );
  }
  // The copies stay only when the run row (and the files' claim) committed with them.
  let claimed = false;
  let committed = false;
  try {
    const result = await submitInTx(
      core,
      actor,
      withViewing,
      clientKey,
      attach,
      () => {
        claimed = true;
      },
      undefined,
      appContext,
    );
    committed = claimed;
    return result;
  } finally {
    if (committed) await stager?.finalize(attach.staged);
    else await stager?.discard(attach.staged);
  }
}

/** Validates the files and copies them (object store, no transaction held); see uploads/attach.ts. */
async function stageAttachments(
  core: RunCore,
  actor: ActorContext,
  command: SubmitMessageCommand,
  clientKey: string | null,
): Promise<StagedAttachments | undefined> {
  const stager = core.workspace.attachments();
  if (stager === undefined) throw new RunError("attachments_unavailable");
  const caller = { teamId: actor.team_id, userId: actor.user_id };
  const found = await core.threadTx(actor, async (tx, viewer) => {
    const thread = await lockOwnedThread(tx, viewer, command.thread_id, "thread_not_found");
    // A repeated submission is answered with its run; nothing to attach again.
    if (clientKey !== null && (await runByClientKey(tx, caller.teamId, thread.id, clientKey))) {
      return undefined;
    }
    const files = await stager.inspect(tx, caller, thread.id, command.file_ids ?? []);
    return {
      threadId: thread.id,
      owner: { teamId: caller.teamId, userId: thread.ownerUserId },
      files,
    };
  });
  if (found === undefined) return undefined;
  const staged = await stager.stage(found.owner, caller, found.threadId, found.files);
  return { owner: found.owner, caller, staged };
}

/**
 * The member's viewed file (KOBE-462, spec FE6), read from their own synced workspace before the
 * transaction (object storage); only for their own messages. Missing or unreadable: only its
 * path, which the viewed-file guard still applies to (KOBE-493); the run gets no context.
 */
async function readViewing(
  core: RunCore,
  actor: ActorContext,
  command: SubmitMessageCommand,
): Promise<StoredViewing | undefined> {
  if (command.trigger !== "user") return undefined;
  const fromEntry = command.viewing_from_entry;
  if (command.viewing === undefined && fromEntry === undefined) return undefined;
  // Only the thread's owner sends into it, from their own workspace (review: check first; the
  // submit transaction refuses anyone else with its own error).
  const found = await core.readTx(actor, async (tx, viewer) => {
    const thread = await findThread(tx, viewer, command.thread_id);
    if (thread?.access !== "owner") return undefined;
    // A regenerate (KOBE-467): the path the prompt's run viewed, read again below.
    const path =
      fromEntry === undefined
        ? command.viewing?.path
        : await promptViewingPath(tx, actor.team_id, thread.thread.id, fromEntry);
    return path === undefined ? undefined : { owner: thread.thread.ownerUserId, path };
  });
  return viewingOf(core, actor, found);
}

/** The file as read, else only its path (KOBE-493); undefined when nothing was viewed. */
async function viewingOf(
  core: RunCore,
  actor: ActorContext,
  found: { readonly owner: string; readonly path: string } | undefined,
): Promise<StoredViewing | undefined> {
  // Agent-internal files are never the member's to view (nor guarded).
  if (found === undefined || isInternalPath(found.path)) return undefined;
  const reader = core.workspace.viewing();
  const read =
    reader === undefined
      ? undefined
      : await reader({ teamId: actor.team_id, userId: found.owner }, found.path);
  return read ?? { path: found.path };
}

/**
 * A retry's viewed file (KOBE-462 FE7): the original's path (its text was cleared when it
 * ended), read again from the owner's workspace once the run is known to be theirs.
 */
export async function retryViewing(
  core: RunCore,
  actor: ActorContext,
  runId: string,
): Promise<StoredViewing | undefined> {
  const found = await core.readTx(actor, async (tx, viewer) => {
    const { thread } = await ownedRun(tx, viewer, runId, false);
    const path = await runViewingPath(tx, actor.team_id, runId);
    return path === undefined ? undefined : { owner: thread.ownerUserId, path };
  });
  return viewingOf(core, actor, found);
}

async function submitInTx(
  core: RunCore,
  actor: ActorContext,
  command: SubmitMessageCommand & { readonly resolvedViewing?: StoredViewing },
  clientKey: string | null,
  attach: StagedAttachments | undefined,
  onAttached: () => void,
  scheduled?: ScheduledSubmit,
  appContext: readonly ResolvedAppContext[] = [],
): Promise<SubmitMessageResult> {
  const teamId = actor.team_id;
  const out = await core.threadTx(actor, async (tx, viewer) => {
    await scheduled?.before(tx);
    const thread = await lockOwnedThread(tx, viewer, command.thread_id, "thread_not_found");
    if (clientKey !== null) {
      // A repeated submission (same key, same thread) answers with the run it created.
      const seen = await runByClientKey(tx, teamId, thread.id, clientKey);
      if (seen) return { result: { run_id: seen.id, queued: seen.status === "queued" } };
    }
    // App context from a connector turned off in this thread is refused (review LOW-5).
    if (appContext.length > 0) {
      const off = await connectorsOffIn(tx, teamId, thread.id);
      if (appContext.some((a) => a.connectorId !== undefined && off.has(a.connectorId))) {
        throw new RunError("app_context_invalid");
      }
    }
    // @file mentions (KOBE-223) resolve against the owner's own workspace, never the client's
    // word. A member's bad mention refuses the message; a schedule's file that is gone by now
    // stays literal text and the run goes ahead.
    const mentioned = await rewriteMentions(
      tx,
      ownerOf(teamId, thread),
      command.content,
      command.mentions ?? [],
      command.trigger === "user" ? "refuse" : "keep",
    );
    if (mentioned.skipped > 0) {
      core.log.warn(
        { team_id: teamId, thread_id: thread.id, skipped: mentioned.skipped },
        "mentioned files not found; left as text",
      );
    }
    // A skill picked in the composer (KOBE-451) must be one a run here loads; the server's
    // line asks the agent to use it. The run start checks it once more.
    const skill = command.trigger === "user" ? command.skill : undefined;
    if (skill !== undefined) {
      const names = await effectiveSkillNames(tx, core.agents, {
        teamId,
        ...thread,
        threadId: thread.id,
      });
      if (!names.includes(skill)) throw new RunError("skill_not_available");
    }
    // Items an app put in the composer as chips (KOBE-490): one line after the member's text.
    const own = withItemReferences(
      command.trigger === "user" ? (command.references ?? []) : [],
      mentioned.text,
    );
    const text = skill === undefined ? own : withSkillRequest(skill, own);
    // The member's chips go first, fenced as untrusted data (KOBE-439, spec §8).
    const input = withAppContext(appContext, text);
    // The rendered blocks count toward the input's limit (review LOW-F): a clear 413.
    if (input.length > RUN_INPUT_MAX_CHARS) throw new RunError("message_too_large");
    // A scheduled run the budget refuses is recorded as failed below (no retry storm, KOBE-174).
    const budgetBlocked = await budgetBlocksSchedule(core, tx, actor, scheduled !== undefined);
    const parent = command.parent_entry_id ?? null;
    if (parent !== null && !(await entryExists(tx, teamId, thread.id, parent))) {
      throw new RunError("entry_not_found");
    }
    // The skipped-actions note is not in Pi's session: branching from it would fail the run.
    if (parent !== null && (await isSkippedSummaryEntry(tx, teamId, thread.id, parent))) {
      throw new RunError("invalid_parent_entry");
    }
    if ((await queuedCount(tx, teamId, thread.id)) >= core.tuning.maxQueuedPerThread) {
      throw new RunError("queue_full");
    }
    const requested: ApprovalMode =
      command.trigger === "schedule" ? "auto" : (command.approval_mode ?? "ask-on-write");
    const approvalMode = clampApprovalMode(requested, await readApprovalFloor(tx));
    const id = await insertQueuedRun(tx, {
      teamId,
      threadId: thread.id,
      trigger: command.trigger,
      approvalMode,
      input,
      parentEntryId: parent,
      retryOfRunId: null,
      clientKey,
      viewing: command.resolvedViewing ?? null,
    });
    if (attach) {
      await core.workspace
        .attachments()
        ?.commit(tx, attach.owner, attach.caller, thread.id, id, attach.staged);
      onAttached();
    }
    await touchThread(tx, teamId, thread.id);
    if (budgetBlocked) {
      const run = await getRunRow(tx, teamId, id);
      if (!run) throw new Error("scheduled run vanished in its own transaction");
      const applied = await applyTransition(
        tx,
        thread,
        run,
        "failed",
        "error",
        failedEvent("budget_exhausted"),
      );
      await scheduled?.after(tx, { runId: id, budgetBlocked });
      return { result: { run_id: id, queued: false }, transitions: [applied.transition] };
    }
    // A user's new message releases a queue paused by Stop: it joins the end, earlier ones go
    // first. Scheduled runs (KOBE-64) queue behind a paused queue without releasing it.
    if (command.trigger === "user") await setQueuePaused(tx, teamId, thread.id, false);
    const { promotion, queued } = await core.promoteOrQueue(tx, teamId, thread.id, id);
    await scheduled?.after(tx, { runId: id, budgetBlocked });
    return { result: { run_id: id, queued }, promotion };
  });
  if ("transitions" in out && out.transitions) core.emit(teamId, out.transitions);
  if ("promotion" in out && out.promotion) core.afterCommit(teamId, out.promotion);
  return out.result;
}

/**
 * The account check of a new run, plus the budget gate: a scheduled run the gate refuses is not
 * thrown away (that would be retried every tick) but reported to the caller to fail visibly.
 */
async function budgetBlocksSchedule(
  core: RunCore,
  tx: KaijuTx,
  actor: ActorContext,
  scheduled: boolean,
): Promise<boolean> {
  try {
    await core.assertMayRun(tx, actor);
    return false;
  } catch (err) {
    if (scheduled && err instanceof RunError && err.code === "budget_exhausted") return true;
    throw err;
  }
}
