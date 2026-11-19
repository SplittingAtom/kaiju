import { randomBytes } from "node:crypto";
import {
  MEMORY_LEARN_SCHEMA_RETRIES,
  SERVER_CALL_LIMITS,
  parseMemoryExtractorOutput,
  type MemoryExtractorOutput,
  type MemoryPassFailureCode,
  type MemoryPassStage,
} from "@kobe/protocol";
import { withTeam, type KobeDb } from "@kobe/db";
import { SpanKind, withSpan, type Span } from "@kobe/telemetry";
import type { Logger } from "pino";
import { appendRunEventsInTx, withAppendTx } from "../../event-stream/append.js";
import { ServerCallError, type ServerCallClient } from "../../models/gateway-client.js";
import { readSwitches } from "../switches.js";
import { checkCandidates, insertCandidates, readKnownStatements } from "./candidates.js";
import type { LearningPassInput } from "./pass-input/assemble.js";
import { auditPassCompleted, auditPassFailed } from "./audit.js";
import { noticeCandidatesReady } from "../review/notify.js";
import { completePass, failPass, moveWatermark } from "./passes.js";
import { extractorMessages } from "./prompt/index.js";
import { screenExtractorOutput } from "./screen.js";
import {
  failureForCode,
  failureMessage,
  failureRetryable,
  learnTarget,
  type LearnTarget,
} from "./target.js";
import { selectCandidates } from "./validate.js";

/**
 * One learning pass's work after its row is `running` (KOBE-393, SM15), on BackgroundTasks:
 * progress events, one `memory_learn` call on the learning model (retried once on a schema
 * reject), the screen (screen.ts), selection (validate.ts) and save checks (candidates.ts), then
 * in one transaction the candidates, the completed event, the pass row and the watermark. Any
 * failure fails the pass with a code (never model output) and leaves the watermark where it was.
 * Events go to the run the token is bound to (the leaf path's last completed run).
 */

export interface PassContext {
  readonly db: KobeDb;
  readonly client: ServerCallClient;
  readonly log: Pick<Logger, "info" | "warn">;
  /** The call's timeout (default the purpose's `timeout_ms`). */
  readonly timeoutMs?: number;
}

export interface RunningPass {
  readonly teamId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly passId: string;
  readonly runId: string;
  readonly modelAlias: string;
  readonly promptVersion: string;
}

const attempts = (usage: Record<string, unknown>): number =>
  typeof usage.attempts === "number" ? usage.attempts : 0;

const UNREADABLE_REPLY: ReadonlySet<string> = new Set(["empty_content", "truncated", "bad_reply"]);

class PassFailure extends Error {
  constructor(
    readonly code: MemoryPassFailureCode,
    readonly detail?: string,
  ) {
    super(`learning pass failed: ${code}`);
  }
}

/** What the pass row keeps besides its status (≤ 4 KiB; no statements, no model text). */
function inputRecord(input: LearningPassInput) {
  return {
    entries: input.prompt.transcript.length,
    mode: input.mode,
    truncated: input.truncated,
    summarised: input.summarised,
    partial: input.partial,
    tool_outputs: input.toolOutputs,
    estimated_tokens: input.estimatedTokens,
    skipped: input.skipped,
  };
}

async function appendPassEvent(ctx: PassContext, pass: RunningPass, type: string, payload: object) {
  await withAppendTx(ctx.db, pass.teamId, (tx) =>
    appendRunEventsInTx(tx, pass.teamId, pass.runId, [
      { type, payload: { pass_id: pass.passId, thread_id: pass.threadId, ...payload } },
    ]),
  );
}

const progress = (ctx: PassContext, pass: RunningPass, stage: MemoryPassStage, extra = {}) =>
  appendPassEvent(ctx, pass, "memory.pass.progress", { stage, ...extra });

/** Messages with a fresh nonce (a new one if the data happens to hold it), and that nonce. */
function messagesFor(input: LearningPassInput) {
  for (let i = 0; i < 3; i += 1) {
    const nonce = randomBytes(16).toString("hex");
    const built = extractorMessages(input.prompt, nonce);
    if (built.ok) return { ...built, nonce };
    if (built.reason !== "nonce_in_content") return built;
  }
  return { ok: false as const, reason: "nonce_in_content" as const };
}

async function extract(
  ctx: PassContext,
  pass: RunningPass,
  input: LearningPassInput,
  target: Extract<LearnTarget, { ok: true }>,
  usage: { attempts: number },
): Promise<{ output: MemoryExtractorOutput; nonce: string }> {
  const built = messagesFor(input);
  if (!built.ok) throw new PassFailure("model_error", `input_${built.reason}`);
  const timeoutMs = ctx.timeoutMs ?? SERVER_CALL_LIMITS.memory_learn.timeout_ms;
  for (let attempt = 0; attempt <= MEMORY_LEARN_SCHEMA_RETRIES; attempt += 1) {
    usage.attempts += 1;
    let reply: string;
    try {
      reply = await ctx.client.complete({
        purpose: "memory_learn",
        teamId: pass.teamId,
        userId: pass.userId,
        threadId: pass.threadId,
        runId: pass.runId,
        passId: pass.passId,
        model: target.model,
        reasoning: target.reasoning,
        catalogMaxOutputTokens: target.maxOutputTokens,
        structured: target.structured,
        messages: built.messages,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = err instanceof ServerCallError ? err.code : "internal";
      // An unusable reply (cut off, empty, not a completion) is retried like a schema reject.
      if (UNREADABLE_REPLY.has(code)) continue;
      throw new PassFailure(failureForCode(code), code);
    }
    const parsed = parseMemoryExtractorOutput(reply);
    if (parsed.ok) return { output: parsed.output, nonce: built.nonce };
  }
  throw new PassFailure("schema_rejected");
}

/** Screens, selects, checks and stores; completes the pass in one transaction. */
async function finish(
  ctx: PassContext,
  pass: RunningPass,
  input: LearningPassInput,
  { output, nonce }: { output: MemoryExtractorOutput; nonce: string },
  usage: Record<string, unknown>,
  span: Span,
): Promise<void> {
  const screen = screenExtractorOutput(output, input.prompt, nonce);
  await withAppendTx(ctx.db, pass.teamId, async (tx) => {
    const known = await readKnownStatements(tx, pass);
    const selection = selectCandidates(screen.kept, known);
    const { memory } = await readSwitches(tx, pass.teamId);
    const checked = await checkCandidates(tx, { ...pass, memory }, selection.selected);
    await insertCandidates(tx, pass, checked.kept, pass.promptVersion);
    const dropped = screen.dropped.length + selection.dropped.length + checked.dropped.length;
    const counts = {
      replied: output.candidates.length,
      stored: checked.kept.length,
      dropped,
      skill_hints: screen.skill_hints.length,
    };
    // Event first: the guard admits it only while the row is still running.
    await appendRunEventsInTx(tx, pass.teamId, pass.runId, [
      {
        type: "memory.pass.completed",
        payload: {
          pass_id: pass.passId,
          thread_id: pass.threadId,
          candidates: counts.stored,
          dropped: Math.min(dropped, 20),
          skill_hints: counts.skill_hints,
        },
      },
    ]);
    const done = await completePass(tx, {
      teamId: pass.teamId,
      passId: pass.passId,
      toEntryId: input.leafEntryId,
      usage: { ...usage, counts, skill_hints: screen.skill_hints },
    });
    if (!done) throw new PassFailure("cancelled", "pass_not_running");
    await moveWatermark(tx, { ...pass, entryId: input.leafEntryId });
    await auditPassCompleted(tx, pass, counts, attempts(usage));
    // To review's bell notice and reminder (KOBE-396): last, it holds the digest lock to commit.
    await noticeCandidatesReady(tx, pass, counts.stored);
    span.setAttributes({
      "kobe.memory.candidates": counts.stored,
      "kobe.memory.dropped": dropped,
      "kobe.memory.replied": counts.replied,
      "kobe.memory.skill_hints": counts.skill_hints,
    });
  });
}

/** Fails the pass: its event and row together, else the row alone (the window may have closed). */
async function fail(
  ctx: PassContext,
  pass: RunningPass,
  code: MemoryPassFailureCode,
  usage: Record<string, unknown>,
  detail?: string,
): Promise<void> {
  const end = {
    teamId: pass.teamId,
    passId: pass.passId,
    usage,
    error: detail === undefined ? code : `${code}: ${detail}`,
  };
  try {
    await withAppendTx(ctx.db, pass.teamId, async (tx) => {
      await appendRunEventsInTx(tx, pass.teamId, pass.runId, [
        {
          type: "memory.pass.failed",
          payload: {
            pass_id: pass.passId,
            thread_id: pass.threadId,
            code,
            message: failureMessage(code),
            retryable: failureRetryable(code),
          },
        },
      ]);
      if (await failPass(tx, end)) await auditPassFailed(tx, pass, code, attempts(usage));
    });
  } catch {
    await withTeam(ctx.db, pass.teamId, async (tx) => {
      if (await failPass(tx, end)) await auditPassFailed(tx, pass, code, attempts(usage));
    });
  }
}

export async function executePass(
  ctx: PassContext,
  pass: RunningPass,
  input: LearningPassInput,
): Promise<void> {
  const usage = {
    model_alias: pass.modelAlias,
    prompt_version: pass.promptVersion,
    attempts: 0,
    input: inputRecord(input),
  };
  await withSpan(
    "memory.learn_pass",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "kobe.team_id": pass.teamId,
        "kobe.thread_id": pass.threadId,
        "kobe.run_id": pass.runId,
        "kobe.memory.pass_id": pass.passId,
        "kobe.memory.model_alias": pass.modelAlias,
        "kobe.memory.prompt_version": pass.promptVersion,
        "kobe.memory.entries": input.prompt.transcript.length,
        "kobe.memory.partial": input.partial,
      },
    },
    async (span) => {
      try {
        await progress(ctx, pass, "reading", { entries: input.prompt.transcript.length });
        const target = await withTeam(ctx.db, pass.teamId, (tx) =>
          learnTarget(tx, pass.teamId, pass.modelAlias),
        );
        if (!target.ok) throw new PassFailure("learning_model_unavailable", "not_enabled");
        span.setAttribute("gen_ai.request.model", target.model);
        await progress(ctx, pass, "extracting");
        const extracted = await extract(ctx, pass, input, target, usage);
        await progress(ctx, pass, "checking");
        await finish(ctx, pass, input, extracted, usage, span);
        span.setAttribute("kobe.memory.outcome", "completed");
      } catch (err) {
        const failure =
          err instanceof PassFailure ? err : new PassFailure("model_error", "internal");
        if (!(err instanceof PassFailure))
          ctx.log.warn({ err, pass_id: pass.passId }, "learning pass failed unexpectedly");
        else
          ctx.log.info(
            { code: failure.code, detail: failure.detail, pass_id: pass.passId },
            "learning pass failed",
          );
        span.setAttributes({
          "kobe.memory.outcome": "failed",
          "kobe.memory.failure": failure.code,
        });
        await fail(ctx, pass, failure.code, usage, failure.detail);
      }
    },
  );
}
