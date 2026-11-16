import {
  MEMORY_LEARN_SCHEMA_RETRIES,
  SERVER_CALL_LIMITS,
  SERVER_CALL_REASONING_EFFORT,
  SERVER_CALL_RESPONSE_FORMATS,
  parseMemoryExtractorOutput,
  serverCallOutputCapFor,
  type ServerCallRequest,
} from "@kobe/protocol";
import type { Attempt } from "./score.js";

/**
 * The extractor eval's model call (KOBE-400): one OpenAI-compatible `POST <base>/chat/completions`
 * with the body the server sends for a `memory_learn` server call (`models/gateway-client.ts`
 * `bodyOf`: the purpose's output cap clamped to the catalog's, temperature 0, `reasoning_effort`
 * for a reasoning model, the extractor's `response_format` where the provider takes it), and the
 * pass's retry rule (`learn/execute.ts`: one more try on a schema reject or an unusable reply).
 *
 * It talks to the provider directly, not through the model gateway: the gateway admits a
 * `memory_learn` call only for a running pass of a real thread (KOBE-391), so an eval of 100
 * seeded transcripts cannot go through it. The model and its request are otherwise the server's.
 */

export interface ModelTarget {
  /** OpenAI-compatible base URL (ending in `/v1` for most providers). */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** The provider's model id, as sent in the body. */
  readonly model: string;
  readonly reasoning: boolean;
  readonly structured: boolean;
  readonly catalogMaxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export function requestBody(
  target: ModelTarget,
  messages: ServerCallRequest["messages"],
): Record<string, unknown> {
  return {
    model: target.model,
    messages,
    max_tokens: serverCallOutputCapFor(
      "memory_learn",
      target.reasoning,
      target.catalogMaxOutputTokens,
    ),
    temperature: SERVER_CALL_LIMITS.memory_learn.temperature,
    stream: false,
    ...(target.reasoning ? { reasoning_effort: SERVER_CALL_REASONING_EFFORT } : {}),
    ...(target.structured ? { response_format: SERVER_CALL_RESPONSE_FORMATS.memory_learn } : {}),
  };
}

interface Completion {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The first choice's text, or a short code (as the server's client: never response text). */
function replyText(json: Completion): { text: string } | { error: string } {
  const choice = json.choices?.[0];
  if (!choice?.message) return { error: "bad_reply" };
  if (choice.finish_reason === "length") return { error: "truncated" };
  const content = choice.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((p: { type?: unknown; text?: unknown }) =>
              p?.type === "text" && typeof p.text === "string" ? p.text : "",
            )
            .join("")
        : "";
  return text.trim() === "" ? { error: "empty_content" } : { text };
}

async function callOnce(
  target: ModelTarget,
  messages: ServerCallRequest["messages"],
  doFetch: typeof fetch,
): Promise<Attempt> {
  const started = performance.now();
  const timeoutMs = target.timeoutMs ?? SERVER_CALL_LIMITS.memory_learn.timeout_ms;
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await doFetch(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody(target, messages)),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const raw = await res.text();
    if (!res.ok) return { error: `http_${res.status}`, latency_ms: elapsed() };
    let json: Completion;
    try {
      json = JSON.parse(raw) as Completion;
    } catch {
      return { error: "bad_reply", latency_ms: elapsed() };
    }
    const promptTokens = num(json.usage?.prompt_tokens);
    const completionTokens = num(json.usage?.completion_tokens);
    const usage = {
      ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
      ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
    };
    return { ...replyText(json), latency_ms: elapsed(), ...usage };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { error: timedOut ? "timeout" : "unreachable", latency_ms: elapsed() };
  }
}

const RETRYABLE: ReadonlySet<string> = new Set(["empty_content", "truncated", "bad_reply"]);

/** A pass's call: retried once on a schema reject or an unusable reply, as the server does. */
export async function extractWithModel(
  target: ModelTarget,
  messages: ServerCallRequest["messages"],
  doFetch: typeof fetch = fetch,
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (let i = 0; i <= MEMORY_LEARN_SCHEMA_RETRIES; i += 1) {
    const a = await callOnce(target, messages, doFetch);
    attempts.push(a);
    if (a.text !== undefined && parseMemoryExtractorOutput(a.text).ok) break;
    if (a.error !== undefined && !RETRYABLE.has(a.error)) break;
  }
  return attempts;
}
