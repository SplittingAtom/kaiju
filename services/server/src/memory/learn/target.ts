import { eq, modelCatalog, modelProviders, type KobeTx } from "@kobe/db";
import type { MemoryPassFailureCode } from "@kobe/protocol";
import { resolveRunModel } from "../../runs/models.js";

/**
 * The learning model's gateway id for one pass (KOBE-393), read again right before the call: the
 * alias chosen at start (`learning-model.ts`) must still be enabled for the Workspace, or the pass
 * fails `learning_model_unavailable`. Never another model.
 */
export type LearnTarget =
  | {
      readonly ok: true;
      readonly model: string;
      readonly reasoning: boolean;
      readonly structured: boolean;
      readonly maxOutputTokens: number | null;
    }
  | { readonly ok: false };

/** Provider kinds known to take `response_format: json_schema` through the gateway (as the judge). */
const STRUCTURED_OUTPUT_KINDS: ReadonlySet<string> = new Set(["openai"]);

export async function learnTarget(tx: KobeTx, teamId: string, alias: string): Promise<LearnTarget> {
  const resolved = await resolveRunModel(tx, teamId, alias);
  if (!resolved.ok || resolved.model === undefined) return { ok: false };
  const [row] = await tx
    .select({ kind: modelProviders.kind })
    .from(modelCatalog)
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
    .where(eq(modelCatalog.alias, alias));
  return {
    ok: true,
    model: resolved.model.gateway_model,
    reasoning: resolved.limits?.reasoning === true,
    structured: row !== undefined && STRUCTURED_OUTPUT_KINDS.has(row.kind),
    maxOutputTokens: resolved.limits?.maxOutputTokens ?? null,
  };
}

/** The gateway's (or client's) refusal code as a pass failure. */
export function failureForCode(code: string): MemoryPassFailureCode {
  if (code === "timeout") return "timeout";
  if (code === "budget_exhausted" || code === "budget_below_call" || code === "budget_soft_limit")
    return "budget_exhausted";
  if (code === "model_not_enabled" || code === "model_blocked") return "learning_model_unavailable";
  return "model_error";
}

const MESSAGES: Readonly<Record<MemoryPassFailureCode, string>> = {
  budget_exhausted:
    "A budget is used up, so Kobe can't learn from this chat until it resets or an admin raises it.",
  learning_model_unavailable:
    "The learning model isn't enabled in this workspace any more. A team admin enables it in Workspace settings › Models, or picks another learning model.",
  memory_disabled: "Memory or Learn from this chat was turned off.",
  schema_rejected: "The learning model's answer couldn't be read, twice. Try again.",
  timeout: "The learning model took too long to answer. Try again.",
  model_error: "The learning model couldn't be reached. Try again.",
  cancelled: "The pass was cancelled.",
  thread_busy: "The chat stayed busy while Kobe saved what it learned. Try again.",
};

/** Whether "Try again" is offered (not for a used-up budget, a switch or a missing model). */
const NOT_RETRYABLE: ReadonlySet<MemoryPassFailureCode> = new Set([
  "learning_model_unavailable",
  "memory_disabled",
  "budget_exhausted",
]);

export const failureMessage = (code: MemoryPassFailureCode): string => MESSAGES[code];
export const failureRetryable = (code: MemoryPassFailureCode): boolean => !NOT_RETRYABLE.has(code);
