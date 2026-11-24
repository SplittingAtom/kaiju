import { embeddingsResponseSchema } from "@kaiju/protocol";

/**
 * The relevance harness's embedding endpoint (KOBE-409 ac-1): any OpenAI-compatible
 * `POST <url>/embeddings` (a LAN Ollama's `/v1`, the in-cluster model, a hosted provider), called
 * directly, not through the gateway: the harness measures ranking, not billing. From the
 * operator's shell, never committed:
 *   KOBE_EVAL_EMBED_URL    base URL ending in /v1 (required for the hybrid comparison)
 *   KOBE_EVAL_EMBED_MODEL  the endpoint's model name, e.g. nomic-embed-text
 *   KOBE_EVAL_EMBED_KEY    bearer key, if the endpoint needs one
 */
export interface EmbedEndpoint {
  readonly url: string;
  readonly model: string;
  readonly key: string | undefined;
  /** The id vectors are stored under (`eval/<model>`: prefixes follow the model's family). */
  readonly storedModel: string;
}

export function endpointFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): EmbedEndpoint | undefined {
  const url = env.KOBE_EVAL_EMBED_URL?.replace(/\/+$/, "");
  const model = env.KOBE_EVAL_EMBED_MODEL;
  if (!url || !model) return undefined;
  return { url, model, key: env.KOBE_EVAL_EMBED_KEY || undefined, storedModel: `eval/${model}` };
}

/** One vector per text, in order; batches of 32. */
export async function embedTexts(e: EmbedEndpoint, texts: readonly string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await fetch(`${e.url}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(e.key ? { authorization: `Bearer ${e.key}` } : {}),
      },
      body: JSON.stringify({ model: e.model, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`embedding endpoint answered ${res.status}`);
    const parsed = embeddingsResponseSchema.parse(await res.json());
    const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

/** The q-th quantile of `values` (nearest rank). */
export function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}
