import { describe, expect, it } from "vitest";
import {
  MEMORY_EMBED_MAX_INPUT_CHARS,
  MEMORY_EMBED_MAX_INPUTS,
  OPTIONAL_RUN_SERVER_CALL_PURPOSES,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_EMBEDDINGS_PATH,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_PURPOSES,
  SERVER_CALL_TOKEN_PURPOSES,
  embeddingsResponseSchema,
  serverCallBoundToRun,
  serverCallClaimsSchema,
  serverCallEmbeddingsRequestSchema,
  serverCallPathFor,
  serverCallRunOptional,
  type ServerCallClaims,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

/** KOBE-409: the `memory_embed` server-call purpose and the embeddings body (contract only). */
const NOW = 1_800_000_000;
const EMBED: ServerCallClaims = {
  iss: "kobe-server",
  aud: SERVER_CALL_AUDIENCE,
  purpose: "memory_embed",
  team_id: EXAMPLE_IDS.team,
  user_id: EXAMPLE_IDS.user,
  model: "kobe-local/nomic-embed-text",
  max_output_tokens: 1,
  iat: NOW,
  exp: NOW + 30,
  jti: "jti-0123456789abcdef",
};
const parse = (claims: Record<string, unknown>) => serverCallClaimsSchema.safeParse(claims).success;

describe("memory_embed purpose (KOBE-409)", () => {
  it("is a token purpose, never an epilogue, with the run optional", () => {
    expect(SERVER_CALL_TOKEN_PURPOSES).toContain("memory_embed");
    expect(SERVER_CALL_PURPOSES as readonly string[]).not.toContain("memory_embed");
    expect(OPTIONAL_RUN_SERVER_CALL_PURPOSES).toEqual(["memory_embed"]);
    expect(serverCallRunOptional("memory_embed")).toBe(true);
    expect(serverCallBoundToRun("memory_embed")).toBe(false);
    expect(serverCallRunOptional("memory_learn")).toBe(false);
  });

  it("names its run and thread both or neither", () => {
    expect(parse(EMBED)).toBe(true);
    expect(parse({ ...EMBED, run_id: EXAMPLE_IDS.run, thread_id: EXAMPLE_IDS.thread })).toBe(true);
    expect(parse({ ...EMBED, run_id: EXAMPLE_IDS.run })).toBe(false);
    expect(parse({ ...EMBED, thread_id: EXAMPLE_IDS.thread })).toBe(false);
  });

  it("generates no text: its output cap is the minimum", () => {
    expect(parse({ ...EMBED, max_output_tokens: 2 })).toBe(false);
    expect(SERVER_CALL_LIMITS.memory_embed.skip_at_percent).toBe(100);
    expect(SERVER_CALL_LIMITS.memory_embed.max_message_chars).toBe(MEMORY_EMBED_MAX_INPUT_CHARS);
  });

  it("uses the embeddings route only; every other purpose the chat route", () => {
    expect(serverCallPathFor("memory_embed")).toBe(SERVER_CALL_EMBEDDINGS_PATH);
    expect(SERVER_CALL_EMBEDDINGS_PATH).toBe("/v1/embeddings");
    for (const p of SERVER_CALL_TOKEN_PURPOSES.filter((x) => x !== "memory_embed")) {
      expect(serverCallPathFor(p)).toBe(SERVER_CALL_PATH);
    }
  });
});

describe("embeddings body", () => {
  const ok = (body: unknown) => serverCallEmbeddingsRequestSchema.safeParse(body).success;
  const model = "kobe-local/nomic-embed-text";

  it("takes one input or a batch of up to 64, floats only", () => {
    expect(ok({ model, input: "fiscal year" })).toBe(true);
    expect(ok({ model, input: ["a", "b"], encoding_format: "float" })).toBe(true);
    expect(ok({ model, input: Array(MEMORY_EMBED_MAX_INPUTS).fill("x") })).toBe(true);
    expect(ok({ model, input: Array(MEMORY_EMBED_MAX_INPUTS + 1).fill("x") })).toBe(false);
    expect(ok({ model, input: "x".repeat(MEMORY_EMBED_MAX_INPUT_CHARS + 1) })).toBe(false);
    expect(ok({ model, input: "" })).toBe(false);
    expect(ok({ model, input: [] })).toBe(false);
  });

  it("refuses everything else: dimensions, base64, user, extra fields", () => {
    expect(ok({ model, input: "a", dimensions: 256 })).toBe(false);
    expect(ok({ model, input: "a", encoding_format: "base64" })).toBe(false);
    expect(ok({ model, input: "a", user: "u" })).toBe(false);
    expect(ok({ model, input: "a", messages: [] })).toBe(false);
  });

  it("reads back finite vectors with their index", () => {
    const r = embeddingsResponseSchema.safeParse({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, -0.2] }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
    expect(r.success).toBe(true);
    expect(
      embeddingsResponseSchema.safeParse({ data: [{ index: 0, embedding: [] }] }).success,
    ).toBe(false);
  });
});
