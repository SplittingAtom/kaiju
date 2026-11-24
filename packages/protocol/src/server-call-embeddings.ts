import { z } from "zod";
import { gatewayModelSchema } from "./sandbox-wire/frames/model.js";

/**
 * Embedding server calls (KOBE-409, v1.3 Semantic Memory SMD2). The server embeds memory item
 * statements (on save, backfill, re-embed) and the selector's per-message query through the model
 * gateway, with a server-call token of purpose `memory_embed` (server-call.ts). That purpose may use
 * only {@link SERVER_CALL_EMBEDDINGS_PATH}, and the route takes no other credential: sandbox
 * session tokens and run tokens are refused there, so a sandbox can never reach an embedding model.
 *
 * Billing (Chris, 2026-11-15): the token's (team, user) pay, as for every server call: the run's
 * member for the query embedding (`run_id` set), the person saving for embed on save (in the
 * Workspace they act in), and the Site admin who started a backfill or re-embed. A Workspace at
 * 100 % of a budget line skips the embed; the item stays on keyword search.
 */
export const SERVER_CALL_EMBEDDINGS_PATH = "/v1/embeddings";

/** Most inputs in one embedding call (a backfill batch). */
export const MEMORY_EMBED_MAX_INPUTS = 64;
/** Longest input, UTF-16 code units: statements are at most 500; a query is cut to this. */
export const MEMORY_EMBED_MAX_INPUT_CHARS = 4000;
/** Largest vector Kaiju stores (the migration's CHECK on `embedding_dims`). */
export const MEMORY_EMBED_MAX_DIMS = 4096;

const input = z.string().min(1).max(MEMORY_EMBED_MAX_INPUT_CHARS);

/**
 * The body an embedding server call may send: an OpenAI Embeddings subset. Strict: no
 * `dimensions` (the model decides; Kaiju stores what it returns), no `user`, floats only.
 */
export const serverCallEmbeddingsRequestSchema = z.strictObject({
  model: gatewayModelSchema,
  input: z.union([input, z.array(input).min(1).max(MEMORY_EMBED_MAX_INPUTS)]),
  encoding_format: z.literal("float").optional(),
});
export type ServerCallEmbeddingsRequest = z.infer<typeof serverCallEmbeddingsRequestSchema>;

/** What the server reads back: one finite vector per input, in input order by `index`. */
export const embeddingsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number().finite()).min(1).max(MEMORY_EMBED_MAX_DIMS),
      }),
    )
    .min(1)
    .max(MEMORY_EMBED_MAX_INPUTS),
});
export type EmbeddingsResponse = z.infer<typeof embeddingsResponseSchema>;
