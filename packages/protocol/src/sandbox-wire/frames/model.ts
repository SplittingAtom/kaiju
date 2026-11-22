import { z } from "zod";

/** Model wiring shared by `run.start`, `thread.compact` and `thread.branch_summary` (KOBE-41, KOBE-259). */

/**
 * API styles Pi 1.0.x speaks to the model gateway (KOBE-41), by the catalog provider's kind:
 * OpenAI, Ollama and OpenAI-compatible endpoints → `openai-completions` (`<gateway>/v1`),
 * Anthropic → `anthropic-messages` (`<gateway>/anthropic`), Gemini → `google-generative-ai`
 * (`<gateway>/genai/v1beta`). The agent builds the base URL from its own environment.
 */
export const PI_MODEL_APIS = [
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const piModelApiSchema = z.enum(PI_MODEL_APIS);
export type PiModelApi = z.infer<typeof piModelApiSchema>;

/**
 * `<gateway provider>/<model>` as the model gateway names models (KOBE-40 `gateway_model`): a
 * provider of at most 64 characters and a model of at most 191. The one limit for the wire and the
 * kobe-models model file, which ships on its own and pins a copy (KOBE-280), so a `run.start` the
 * agent accepts never starts Pi on a model its model file refuses.
 */
export const GATEWAY_MODEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;
/** The longest id {@link GATEWAY_MODEL_PATTERN} allows (64 + "/" + 191). */
export const GATEWAY_MODEL_MAX_LENGTH = 256;
export const gatewayModelSchema = z
  .string()
  .max(GATEWAY_MODEL_MAX_LENGTH)
  .regex(GATEWAY_MODEL_PATTERN);

/** Upper bound of a model's context window (and so its output limit) on the wire (KOBE-259). */
export const MODEL_LIMITS_MAX_TOKENS = 10_000_000;
const tokenCount = z.number().int().min(1).max(MODEL_LIMITS_MAX_TOKENS);

/**
 * The run model's token limits (KOBE-259), as the server resolved them: the catalog's values, else
 * the site defaults (reasoning models get a higher output default). The sandbox gives them to
 * Pi as the model's `maxTokens` (each call's `max_tokens`) and `contextWindow`. A separate key, not
 * part of `model`, because `model` is strict and an older agent must still accept the frame.
 */
export const modelLimitsSchema = z
  .strictObject({ max_output_tokens: tokenCount, context_window: tokenCount })
  .refine((l) => l.max_output_tokens < l.context_window, {
    message: "max_output_tokens must be below context_window",
  });
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
