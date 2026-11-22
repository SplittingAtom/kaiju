import {
  exhaustedLine,
  isLockTimeout,
  loadMemberBudgetState,
  teams,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../../background.js";
import type { ServerCallClient } from "../../models/gateway-client.js";
import type { Viewer } from "../../threads/repository.js";
import { learnAvailability, type LearnUnavailableReason } from "../learning-model.js";
import { readSwitches } from "../switches.js";
import { auditPassStarted } from "./audit.js";
import { executePass, type CompletionTuning, type RunningPass } from "./execute.js";
import {
  assembleLearningInput,
  type LearningInputOptions,
  type LearningInputRefusal,
  type LearningPassInput,
} from "./pass-input/assemble.js";
import {
  LEARN_PASSES_PER_DAY,
  failStalePasses,
  insertRunningPass,
  leafPathRun,
  lockPassStarts,
  passesToday,
} from "./passes.js";
import { CURRENT_EXTRACTOR_PROMPT } from "./prompt/index.js";

/**
 * Learn from this chat (KOBE-393; SM14, SM15, Q5): the thread author starts a learning pass and
 * the server runs it on BackgroundTasks (execute.ts). {@link LearningPasses.start} checks, in one
 * `withTeam()` transaction under the thread's change lock:
 *
 * 1. the Memory and Learn switches and the learning model (Site alias, Workspace override, enabled
 *    for the Workspace; never a fallback): `memory_disabled` / `memory_learning_model_unavailable`
 *    with the reason;
 * 2. the pass input (KOBE-392: author only, the visible branch, the watermark);
 * 3. {@link LEARN_PASSES_PER_DAY} passes per person per Workspace per rolling day, counted under
 *    a per-person lock so starts on several threads or replicas can't pass it together;
 * 4. the person's budget lines: refused at 100 % (the gateway refuses the call there too);
 * 5. the run the token is bound to: the leaf path's last completed run, leased to the author
 *    (the gateway can only check that it is a completed run of theirs);
 * 6. one active pass per thread, by the database (another replica's pass refuses this one).
 *
 * Nothing is saved to memory: candidates wait for the person's review (KOBE-395/396).
 */

export type LearnStartRefusal =
  | {
      readonly code: "memory_disabled" | "memory_learning_model_unavailable";
      readonly reason: LearnUnavailableReason | "server_calls_off";
      readonly message: string;
    }
  | {
      readonly code: "learn_rate_limited" | "budget_exhausted" | "pass_running" | "thread_busy";
      readonly message: string;
    }
  | {
      readonly code: LearningInputRefusal | "no_completed_run";
      readonly message: string;
      readonly leafEntryId?: string;
    };

export type LearnStartResult =
  | {
      readonly ok: true;
      readonly passId: string;
      readonly runId: string;
      readonly modelAlias: string;
      /** What the pass reads (KOBE-392), e.g. `partial` for "some earlier messages were left out". */
      readonly input: Pick<
        LearningPassInput,
        "truncated" | "summarised" | "partial" | "estimatedTokens" | "toolOutputs" | "skipped"
      > & { readonly entries: number };
    }
  | ({ readonly ok: false } & LearnStartRefusal);

export interface LearningPasses {
  /** False when the server has no model gateway for its own calls: every start is refused. */
  readonly serverCalls: boolean;
  start(
    viewer: Viewer,
    threadId: string,
    options?: LearningInputOptions,
  ): Promise<LearnStartResult>;
  /** Fails running passes past `MEMORY_PASS_MAX_MS` in every Workspace (a stopped server's). */
  sweep(): Promise<number>;
}

export interface LearningPassesOptions {
  readonly db: KobeDb;
  /** Undefined when the server has no model gateway: Learn is unavailable. */
  readonly client: ServerCallClient | undefined;
  readonly background: BackgroundTasks;
  readonly log: Pick<Logger, "info" | "warn">;
  /** Test seam: the call's timeout. */
  readonly timeoutMs?: number;
  /** Test seam: how the completion waits for the thread lock and retries (KOBE-770 review). */
  readonly completion?: CompletionTuning;
  /** Test seam: runs in the start's transaction just before the pass row is claimed. */
  readonly beforeClaim?: (tx: KobeTx) => Promise<void>;
}

export const SWITCH_REASONS: ReadonlySet<LearnUnavailableReason> = new Set([
  "site_memory_off",
  "memory_off",
  "site_learn_off",
  "learn_off",
]);

export const INPUT_MESSAGES: Readonly<Record<LearningInputRefusal | "no_completed_run", string>> = {
  thread_not_found: "Thread not found.",
  read_only: "Only the thread's author can teach Kobe from it.",
  thread_in_trash: "Restore the thread from Trash first.",
  test_thread: "Kobe doesn't learn from test, Workbench or eval chats.",
  break_glass: "Kobe doesn't learn during a break-glass read.",
  not_current_branch: "Make this branch current first.",
  nothing_to_learn: "Nothing new to learn since the last pass.",
  no_completed_run: "Learn works once a reply on this branch has finished.",
};

export const RATE_LIMITED_MESSAGE = `You can teach Kobe ${LEARN_PASSES_PER_DAY} times a day in this workspace. Try again later.`;
export const BUDGET_MESSAGE =
  "A budget is used up, so Kobe can't learn from this chat until it resets or an admin raises it.";
export const PASS_RUNNING_MESSAGE = "Kobe is already learning from this thread.";
export const THREAD_BUSY_MESSAGE = "The chat is busy right now. Try again in a moment.";
export const SERVER_CALLS_OFF_MESSAGE = "This server has no model gateway for its own model calls.";

const refuse = (r: LearnStartRefusal): LearnStartResult => ({ ok: false, ...r });

type Prepared =
  | { readonly ok: true; readonly pass: RunningPass; readonly input: LearningPassInput }
  | { readonly ok: false; readonly result: LearnStartResult };

async function prepare(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  options: LearningInputOptions,
  beforeClaim?: (tx: KobeTx) => Promise<void>,
): Promise<Prepared> {
  const { teamId, userId } = viewer;
  const no = (r: LearnStartRefusal): Prepared => ({ ok: false, result: refuse(r) });
  const switches = await readSwitches(tx, teamId);
  const model = await learnAvailability(tx, teamId, switches);
  if (!model.ok)
    return no({
      code: SWITCH_REASONS.has(model.reason)
        ? "memory_disabled"
        : "memory_learning_model_unavailable",
      reason: model.reason,
      message: model.message,
    });
  const assembled = await assembleLearningInput(tx, viewer, threadId, options);
  if (!assembled.ok)
    return no({
      code: assembled.reason,
      message: INPUT_MESSAGES[assembled.reason],
      ...(assembled.leafEntryId === undefined ? {} : { leafEntryId: assembled.leafEntryId }),
    });
  const input = assembled.input;
  await lockPassStarts(tx, teamId, userId);
  if ((await passesToday(tx, teamId, userId)) >= LEARN_PASSES_PER_DAY)
    return no({ code: "learn_rate_limited", message: RATE_LIMITED_MESSAGE });
  const budget = await loadMemberBudgetState(tx, teamId, userId);
  if (exhaustedLine(budget.lines)) return no({ code: "budget_exhausted", message: BUDGET_MESSAGE });
  const runId = await leafPathRun(tx, teamId, threadId, input.leafEntryId, userId);
  if (runId === null)
    return no({ code: "no_completed_run", message: INPUT_MESSAGES.no_completed_run });
  await failStalePasses(tx, teamId, threadId);
  await beforeClaim?.(tx);
  const passId = await insertRunningPass(tx, {
    teamId,
    threadId,
    userId,
    leafEntryId: input.leafEntryId,
    fromEntryId: input.fromEntryId,
    modelAlias: model.alias,
    promptVersion: CURRENT_EXTRACTOR_PROMPT.version,
  });
  if (passId === null) return no({ code: "pass_running", message: PASS_RUNNING_MESSAGE });
  const pass: RunningPass = {
    teamId,
    userId,
    threadId,
    passId,
    runId,
    modelAlias: model.alias,
    promptVersion: CURRENT_EXTRACTOR_PROMPT.version,
  };
  await auditPassStarted(tx, pass, { ...input, entries: input.prompt.transcript.length });
  return { ok: true, input, pass };
}

export function createLearningPasses(options: LearningPassesOptions): LearningPasses {
  const { db, client, background, log } = options;
  return {
    serverCalls: client !== undefined,
    async start(viewer, threadId, startOptions = {}) {
      if (!client)
        return refuse({
          code: "memory_learning_model_unavailable",
          reason: "server_calls_off",
          message: SERVER_CALLS_OFF_MESSAGE,
        });
      let prepared: Prepared;
      try {
        prepared = await withTeam(db, viewer.teamId, (tx) =>
          prepare(tx, viewer, threadId, startOptions, options.beforeClaim),
        );
      } catch (err) {
        // Another change held the thread past THREAD_LOCK_TIMEOUT (55P03): busy, try again.
        if (isLockTimeout(err))
          return refuse({ code: "thread_busy", message: THREAD_BUSY_MESSAGE });
        throw err;
      }
      if (!prepared.ok) return prepared.result;
      const { pass, input } = prepared;
      const ctx = {
        db,
        client,
        log,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.completion ? { completion: options.completion } : {}),
      };
      background.run("learning pass failed", () => executePass(ctx, pass, input), {
        pass_id: pass.passId,
      });
      return {
        ok: true,
        passId: pass.passId,
        runId: pass.runId,
        modelAlias: pass.modelAlias,
        input: {
          entries: input.prompt.transcript.length,
          truncated: input.truncated,
          summarised: input.summarised,
          partial: input.partial,
          estimatedTokens: input.estimatedTokens,
          toolOutputs: input.toolOutputs,
          skipped: input.skipped,
        },
      };
    },
    async sweep() {
      const all = await db.select({ id: teams.id }).from(teams);
      let failed = 0;
      for (const t of all) failed += await withTeam(db, t.id, (tx) => failStalePasses(tx, t.id));
      return failed;
    },
  };
}
