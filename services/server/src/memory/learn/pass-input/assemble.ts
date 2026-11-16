import { BREAK_GLASS_GRANT_SETTING, sql, type KobeTx } from "@kobe/db";
import { lockForChange, type Viewer } from "../../../threads/repository.js";
import { loadAccess } from "../../../projects/access.js";
import type { ExtractorPromptInput } from "../prompt/input.js";
import { CHARS_PER_TOKEN, DEFAULT_CAPS, fitTranscript, type BudgetCaps } from "./budget.js";
import { collectPieces } from "./collect.js";
import { entrySeq, readBranch, readWatermark } from "./read.js";
import { learningRange, summaryReachesBeforeFork, type RangeMode } from "./range.js";
import { readRelatedItems } from "./related.js";
import type { SkipReason } from "./transcript.js";

/**
 * A learning pass's input (KOBE-392; SM11, SM13, SM15, Chris Q9), assembled in the caller's
 * `withTeam()` transaction for KOBE-393 to hand to `extractorMessages` (prompt/index.ts). Reads
 * only: it neither runs nor records a pass, nor moves the watermark.
 *
 * 1. **Author only.** The thread is locked with the change lock (`lockForChange`): only its owner
 *    passes (a scheduled thread's owner too); a reader of a shared thread gets `read_only`, anyone
 *    else `thread_not_found`. Refused in Trash, on builder test, Workbench and eval threads, and
 *    inside a break-glass read (a grant in force in this transaction).
 * 2. **Visible branch.** Root → `threads.leaf_entry_id`. When the author is viewing another branch
 *    (`viewedLeafEntryId`, per-tab heads, CT3) it answers `not_current_branch`: the panel offers
 *    "Make it current" instead of learning a branch that is not current.
 * 3. **Range** (range.ts): after the watermark when it is on the branch, else after the common
 *    ancestor; `rescan` ignores it; a fork or shared-thread copy never reads its copied prefix.
 * 4. **Transcript** (transcript.ts, budget.ts): committed turns only, `branch_summary` excluded,
 *    tool calls as one-line summaries, tool output only when opted in (cut to 2 KB and fenced);
 *    over ~60k tokens the newest compaction summary plus the newest turns, flagged `truncated`
 *    (`partial` when no summary stands in: in a fork, one folding in pre-fork content is
 *    dropped). An offloaded message is a placeholder that is never evidence.
 * 5. **Related items** (related.ts): every Policy item, then the best 40 of the writable scopes.
 */

/** One listed item's JSON line around its statement (id, scope, kind, policy). */
const ITEM_OVERHEAD_TOKENS = 30;

export interface LearningInputOptions {
  /** Ignore the watermark and read the whole branch (still never before a fork/copy point). */
  readonly rescan?: boolean;
  /** The author opted in to tool output for this pass (default off). */
  readonly includeToolOutputs?: boolean;
  /** The branch head the author is viewing, when the request names one. */
  readonly viewedLeafEntryId?: string;
  /** Test seam: the transcript caps. */
  readonly caps?: BudgetCaps;
}

export type LearningInputRefusal =
  | "thread_not_found"
  | "read_only"
  | "thread_in_trash"
  | "test_thread"
  | "break_glass"
  | "not_current_branch"
  | "nothing_to_learn";

export interface LearningPassInput {
  /** What `extractorMessages` takes. */
  readonly prompt: ExtractorPromptInput;
  readonly threadId: string;
  /** The visible branch's leaf: the pass's `branch_leaf_entry_id` and its new watermark. */
  readonly leafEntryId: string;
  /** First entry of the range read (the pass's `from_entry_id`). */
  readonly fromEntryId: string;
  readonly mode: RangeMode;
  /** The fork/copy point of a fork or shared-thread copy (never read), else null. */
  readonly forkedAtEntryId: string | null;
  /** The thread's project with the author's role in it (KOBE-398 / KOBE-652), else null. */
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly role: "editor" | "reader";
  } | null;
  /** Over the cap: older turns were left out (flag for the panel). */
  readonly truncated: boolean;
  /** A compaction summary stands in for what was left out. */
  readonly summarised: boolean;
  /**
   * Older turns were left out and no summary stands in for them (none, or the only one folded in
   * pre-fork content and was dropped): the panel says "some earlier messages were compacted and
   * left out".
   */
  readonly partial: boolean;
  readonly toolOutputs: "excluded" | "included";
  /** Entries of the range that are not in the transcript, by reason (as far as they were read). */
  readonly skipped: Readonly<Partial<Record<SkipReason, number>>>;
  /** Estimated input tokens (transcript and listed items) for the tooltip. */
  readonly estimatedTokens: number;
}

export type LearningInputResult =
  | { readonly ok: true; readonly input: LearningPassInput }
  | {
      readonly ok: false;
      readonly reason: LearningInputRefusal;
      /** The current leaf, for `not_current_branch` and `nothing_to_learn`. */
      readonly leafEntryId?: string;
    };

async function inBreakGlass(tx: KobeTx): Promise<boolean> {
  const res = await tx.execute<{ grant: string | null }>(
    sql`SELECT NULLIF(current_setting(${BREAK_GLASS_GRANT_SETTING}, true), '') AS grant`,
  );
  return Boolean(res.rows[0]?.grant);
}

async function projectOf(tx: KobeTx, viewer: Viewer, projectId: string | null) {
  if (projectId === null) return null;
  const access = await loadAccess(tx, viewer, projectId);
  if (!access) return null;
  return {
    id: projectId,
    name: access.project.name,
    role: access.can.edit ? ("editor" as const) : ("reader" as const),
  };
}

export async function assembleLearningInput(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  options: LearningInputOptions = {},
): Promise<LearningInputResult> {
  if (await inBreakGlass(tx)) return { ok: false, reason: "break_glass" };
  const locked = await lockForChange(tx, viewer, threadId);
  if (!locked.ok)
    return { ok: false, reason: locked.error === "read_only" ? "read_only" : "thread_not_found" };
  const thread = locked.thread;
  if (thread.deletedAt !== null) return { ok: false, reason: "thread_in_trash" };
  if (thread.isTest || thread.skillTest || thread.skillEval)
    return { ok: false, reason: "test_thread" };
  const leaf = thread.leafEntryId;
  if (leaf === null) return { ok: false, reason: "nothing_to_learn" };
  if (options.viewedLeafEntryId !== undefined && options.viewedLeafEntryId !== leaf)
    return { ok: false, reason: "not_current_branch", leafEntryId: leaf };

  const { teamId, userId } = viewer;
  const forkedAt = thread.forkedAtEntryId ?? null;
  const forked = (thread.forkedFromThreadId ?? null) !== null || forkedAt !== null;
  const path = await readBranch(tx, teamId, threadId, leaf);
  const range = learningRange({
    path,
    fork: forked
      ? {
          forkSeq: forkedAt === null ? null : await entrySeq(tx, teamId, threadId, forkedAt),
          threadCreatedAt: thread.createdAt,
        }
      : null,
    watermark: options.rescan ? null : await readWatermark(tx, teamId, threadId, userId),
    rescan: options.rescan ?? false,
  });
  const rows = path.slice(range.start);
  const pathIndex = new Map(path.map((e, i) => [e.entryId, i]));
  const includeToolOutputs = options.includeToolOutputs ?? false;
  const caps = options.caps ?? DEFAULT_CAPS;
  const collected = await collectPieces(
    tx,
    { teamId, threadId },
    rows,
    {
      includeToolOutputs,
      dropSummary: (kept) => summaryReachesBeforeFork(kept, pathIndex, range.lowerBound),
    },
    caps,
  );
  const fitted = fitTranscript(collected.pieces, caps);
  const first = rows[0];
  if (fitted.transcript.length === 0 || first === undefined)
    return { ok: false, reason: "nothing_to_learn", leafEntryId: leaf };

  const readable = fitted.transcript.filter((e) => !e.placeholder);
  const said = readable.filter((e) => e.speaker === "person").reverse();
  const existing = await readRelatedItems(tx, viewer, {
    text: [...said, ...readable.filter((e) => e.speaker === "assistant").reverse()]
      .map((e) => e.text)
      .join("\n"),
    latest: said[0]?.text ?? "",
  });
  const project = await projectOf(tx, viewer, thread.projectId);
  const truncated = fitted.truncated || collected.stoppedEarly;
  const itemTokens = existing.reduce(
    (n, i) => n + Math.ceil(i.statement.length / CHARS_PER_TOKEN) + ITEM_OVERHEAD_TOKENS,
    0,
  );
  return {
    ok: true,
    input: {
      prompt: {
        project: project === null ? null : { name: project.name.slice(0, 200) },
        existing,
        transcript: [...fitted.transcript],
      },
      threadId,
      leafEntryId: leaf,
      fromEntryId: first.entryId,
      mode: range.mode,
      forkedAtEntryId: forkedAt,
      project,
      truncated,
      summarised: fitted.summarised,
      partial: truncated && !fitted.summarised,
      toolOutputs: includeToolOutputs ? "included" : "excluded",
      skipped: collected.skipped,
      estimatedTokens: fitted.estimatedTokens + itemTokens,
    },
  };
}
