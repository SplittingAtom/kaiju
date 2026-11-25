import type { IncomingMessage } from "node:http";
import {
  currentModelId,
  SERVER_CALL_EMBEDDINGS_PATH,
  type ServerCallClaims,
  type ThinkingLevel,
} from "@kaiju/protocol";
import { topLevelModel, withStreamUsage } from "../body-model.js";
import type { Resolution } from "../principals.js";
import type { Route } from "../routes.js";
import { checkServerCallBody } from "../server-call.js";
import { applyThinking, callThinkingLevel } from "../thinking.js";
import { chargedOutput } from "../usage/charge.js";
import type { GatewayOptions } from "./options.js";

export type PreparedBody =
  | {
      readonly ok: true;
      /** What goes to Bifrost (thinking applied, stream usage asked for). */
      readonly forwardBody: Buffer;
      readonly model: string | undefined;
      readonly outputAllowance: number;
      readonly embeddings: boolean;
      readonly thinkingLevel: ThinkingLevel | undefined;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

const refuse = (status: number, code: string, message: string): PreparedBody => ({
  ok: false,
  status,
  code,
  message,
});

/**
 * The body's model and output allowance, checked against the call's contract: a server call's
 * shape, token model and cap (KOBE-234), or a sandbox POST's top-level model, its refused
 * features and the thinking level the server decided (KOBE-260).
 */
export async function prepareBody(
  options: Pick<GatewayOptions, "runThinking">,
  req: IncomingMessage,
  route: Route,
  serverCall: ServerCallClaims | undefined,
  resolution: Extract<Resolution, { ok: true }>,
  teamId: string,
  runId: string | undefined,
  body: Buffer,
): Promise<PreparedBody> {
  let forwardBody = body;
  let model = route.pathModel;
  let thinkingLevel: ThinkingLevel | undefined;
  // Count-only endpoints generate nothing (KOBE-43 review): no output allowance.
  const countOnly = route.path.endsWith("/count_tokens") || route.path.endsWith(":countTokens");
  let outputAllowance = chargedOutput(undefined, 1, countOnly);
  const embeddings = route.path === SERVER_CALL_EMBEDDINGS_PATH;
  if (serverCall) {
    // The contract's shape, the token's model and cap (no tools, no streaming).
    const current = currentModelId(serverCall.model);
    const checked = checkServerCallBody(
      body,
      serverCall,
      resolution.reasoningModels.has(current),
      resolution.outputCaps.get(current),
    );
    if (!checked.ok) return refuse(checked.status, checked.code, checked.message);
    model = current;
    outputAllowance = chargedOutput(checked.maxOutputTokens, 1, embeddings);
  } else if (req.method === "POST") {
    const scanned = topLevelModel(body);
    if (!scanned.ok) {
      return refuse(
        400,
        "invalid_request",
        "The body must be a JSON object with one string model.",
      );
    }
    if (!route.pathModel) model = scanned.model;
    // KOBE-828: a pre-rename id (`kobe-local/<model>`, from a pod or sandbox of the previous
    // release during the upgrade) is checked, priced and recorded as the model it names now; the
    // body goes to Bifrost as sent, where the sync keeps the old provider name for one release.
    if (model !== undefined) model = currentModelId(model);
    outputAllowance = chargedOutput(scanned.maxOutputTokens, scanned.choices, countOnly);
    // KOBE-43: deferred (background) Responses are billed after the call ends, out of the
    // ledger's sight: refused.
    if (scanned.background) {
      return refuse(
        400,
        "background_not_supported",
        "Background responses are not supported through the model gateway.",
      );
    }
    // KOBE-260 review S5: Bifrost's `fallbacks` would reach other models past every
    // per-model check (enablement, thinking): never from a sandbox.
    if (scanned.fallbacks) {
      return refuse(
        400,
        "fallbacks_not_supported",
        "Model fallbacks are not accepted through the model gateway; the run's model is fixed.",
      );
    }
    // KOBE-260: the thinking level the server decided, in the model's control's form.
    const policy = model === undefined ? undefined : resolution.thinking.get(model);
    if (policy !== undefined) {
      const runLevel = runId === undefined ? undefined : await options.runThinking?.(teamId, runId);
      const level = callThinkingLevel(policy, runLevel ?? undefined, {
        eval: resolution.eval,
      });
      const rewritten = applyThinking(body, route, policy, level);
      if (!rewritten.ok) return refuse(rewritten.status, rewritten.code, rewritten.message);
      forwardBody = rewritten.body;
      thinkingLevel = rewritten.level;
      // Review S7: a written thinking budget is output the reservation must hold.
      if (rewritten.budgetTokens !== undefined && !countOnly) {
        outputAllowance = Math.max(
          outputAllowance,
          chargedOutput(rewritten.budgetTokens, scanned.choices, false),
        );
      }
    }
    // KOBE-43: a streaming Chat Completions call always asks for its usage report.
    if (scanned.stream && route.path === "/v1/chat/completions") {
      forwardBody = withStreamUsage(forwardBody);
    }
  }
  return { ok: true, forwardBody, model, outputAllowance, embeddings, thinkingLevel };
}
