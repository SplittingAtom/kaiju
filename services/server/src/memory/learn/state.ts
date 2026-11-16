import {
  exhaustedLine,
  loadMemberBudgetState,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  MEMORY_PASS_FAILURE_CODES,
  MEMORY_PASS_MAX_MS,
  type LearnRefusal,
  type LearnState,
  type MemoryPassFailureCode,
} from "@kobe/protocol";
import { findThread, type Viewer } from "../../threads/repository.js";
import { learnAvailability } from "../learning-model.js";
import { readSwitches } from "../switches.js";
import { assembleLearningInput } from "./pass-input/assemble.js";
import { LEARN_PASSES_PER_DAY, leafPathRun, passesToday } from "./passes.js";
import {
  BUDGET_MESSAGE,
  INPUT_MESSAGES,
  RATE_LIMITED_MESSAGE,
  SERVER_CALLS_OFF_MESSAGE,
  SWITCH_REASONS,
} from "./run.js";
import { failureMessage } from "./target.js";

/**
 * The thread's Learn state for the composer's + button (KOBE-395; SM12, Q8), read without a lock
 * and without starting anything: why a pass can't start now (the start's own checks, in its
 * order, as far as they can be told without assembling the input), the thread's running pass, new
 * messages since the person's last pass (the dot), and the open candidates from this chat (the
 * count). The start (run.ts) checks everything again; this answer is a hint for the button.
 */

const STALE_SECONDS = MEMORY_PASS_MAX_MS / 1000;
const INTERRUPTED =
  "The server stopped during the last pass, so nothing was learned from it. Try again.";
const FAILED = "The last pass didn't finish. Try again.";

const FAILURE_CODES: ReadonlySet<string> = new Set(MEMORY_PASS_FAILURE_CODES);

/** The person-facing sentence for a failed pass row's `error` (`code` or `code: detail`). */
export function passErrorMessage(error: string | null): string {
  const code = (error ?? "").split(":")[0]?.trim() ?? "";
  if (code === "interrupted") return INTERRUPTED;
  return FAILURE_CODES.has(code) ? failureMessage(code as MemoryPassFailureCode) : FAILED;
}

async function runningPass(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<{ id: string; started: string | Date }>(sql`
    SELECT id, coalesce(started_at, created_at) AS started FROM memory_learning_passes
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND status IN ('queued', 'running')
       AND coalesce(started_at, created_at) > now() - make_interval(secs => ${STALE_SECONDS})
     LIMIT 1`);
  const row = res.rows[0];
  return row ? { pass_id: row.id, started_at: new Date(row.started).toISOString() } : null;
}

async function lastFailure(tx: KobeTx, viewer: Viewer, threadId: string) {
  const res = await tx.execute<{
    id: string;
    status: string;
    error: string | null;
    finished_at: string | Date | null;
  }>(sql`
    SELECT id, status, error, finished_at FROM memory_learning_passes
     WHERE team_id = ${viewer.teamId} AND thread_id = ${threadId} AND user_id = ${viewer.userId}
     ORDER BY created_at DESC LIMIT 1`);
  const row = res.rows[0];
  if (!row || row.status !== "failed" || row.finished_at === null) return null;
  return {
    pass_id: row.id,
    message: passErrorMessage(row.error),
    finished_at: new Date(row.finished_at).toISOString(),
  };
}

async function openCandidates(tx: KobeTx, viewer: Viewer, threadId: string): Promise<number> {
  const res = await tx.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n FROM memory_candidates c
      JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
     WHERE c.team_id = ${viewer.teamId} AND p.thread_id = ${threadId}
       AND p.user_id = ${viewer.userId} AND c.state = 'open' AND c.expires_at > now()`);
  return Number(res.rows[0]?.n ?? 0);
}

async function watermark(tx: KobeTx, viewer: Viewer, threadId: string): Promise<string | null> {
  const res = await tx.execute<{ entry_id: string }>(sql`
    SELECT entry_id FROM memory_learning_watermarks
     WHERE team_id = ${viewer.teamId} AND thread_id = ${threadId} AND user_id = ${viewer.userId}`);
  return res.rows[0]?.entry_id ?? null;
}

type Thread = NonNullable<Awaited<ReturnType<typeof findThread>>>["thread"];

/** The first of the start's checks that refuses, or null (a running pass is not a blocker). */
async function blockerOf(
  tx: KobeTx,
  viewer: Viewer,
  thread: Thread,
  serverCalls: boolean,
  left: number,
): Promise<LearnRefusal | null> {
  const { teamId, userId } = viewer;
  if (thread.deletedAt !== null)
    return { code: "thread_in_trash", message: INPUT_MESSAGES.thread_in_trash };
  if (thread.isTest || thread.skillTest === true || thread.skillEval === true)
    return { code: "test_thread", message: INPUT_MESSAGES.test_thread };
  if (!serverCalls)
    return {
      code: "memory_learning_model_unavailable",
      reason: "server_calls_off",
      message: SERVER_CALLS_OFF_MESSAGE,
    };
  const model = await learnAvailability(tx, teamId, await readSwitches(tx, teamId));
  if (!model.ok)
    return {
      code: SWITCH_REASONS.has(model.reason)
        ? "memory_disabled"
        : "memory_learning_model_unavailable",
      reason: model.reason,
      message: model.message,
    };
  const leaf = thread.leafEntryId;
  if (leaf === null || (await leafPathRun(tx, teamId, thread.id, leaf, userId)) === null)
    return { code: "no_completed_run", message: INPUT_MESSAGES.no_completed_run };
  if (left === 0) return { code: "learn_rate_limited", message: RATE_LIMITED_MESSAGE };
  if (exhaustedLine((await loadMemberBudgetState(tx, teamId, userId)).lines))
    return { code: "budget_exhausted", message: BUDGET_MESSAGE };
  return null;
}

export type LearnStateResult =
  | { readonly ok: true; readonly state: LearnState }
  | { readonly ok: false; readonly code: "thread_not_found" | "read_only" };

/** The state in one `withTeam()` read; a reader of a shared thread gets `read_only`. */
export async function readLearnState(
  db: KobeDb,
  viewer: Viewer,
  threadId: string,
  options: { readonly serverCalls: boolean; readonly estimate?: boolean },
): Promise<LearnStateResult> {
  const read = await withTeam(db, viewer.teamId, async (tx): Promise<LearnStateResult> => {
    const found = await findThread(tx, viewer, threadId);
    if (!found) return { ok: false, code: "thread_not_found" };
    if (found.access !== "owner") return { ok: false, code: "read_only" };
    const { thread } = found;
    const left = Math.max(
      0,
      LEARN_PASSES_PER_DAY - (await passesToday(tx, viewer.teamId, viewer.userId)),
    );
    const mark = await watermark(tx, viewer, threadId);
    return {
      ok: true,
      state: {
        thread_id: threadId,
        blocker: await blockerOf(tx, viewer, thread, options.serverCalls, left),
        running: await runningPass(tx, viewer.teamId, threadId),
        new_messages: thread.leafEntryId !== null && mark !== thread.leafEntryId,
        candidates: await openCandidates(tx, viewer, threadId),
        passes_left: left,
        last_failure: await lastFailure(tx, viewer, threadId),
        estimate: null,
      },
    };
  });
  if (!read.ok || options.estimate !== true || read.state.blocker !== null) return read;
  return { ok: true, state: { ...read.state, estimate: await estimate(db, viewer, threadId) } };
}

/**
 * What `/learn` and `/learn all` would read, in tokens (the pass input's own estimate). Its own
 * read-only transaction (the input takes the thread's change lock briefly); null on any refusal.
 */
async function estimate(db: KobeDb, viewer: Viewer, threadId: string) {
  try {
    return await withTeam(db, viewer.teamId, async (tx) => {
      const all = await assembleLearningInput(tx, viewer, threadId, { rescan: true });
      if (!all.ok) return null;
      const fresh = await assembleLearningInput(tx, viewer, threadId);
      return {
        new_tokens: fresh.ok ? fresh.input.estimatedTokens : null,
        all_tokens: all.input.estimatedTokens,
      };
    });
  } catch {
    // The thread was busy (lock timeout): the tooltip goes without a number.
    return null;
  }
}
