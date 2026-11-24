import { randomUUID } from "node:crypto";
import {
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_LIMITS,
  SERVER_CALL_MAX_MESSAGES,
  SERVER_CALL_RESPONSE_FORMATS,
  type ServerCallClaims,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { checkServerCallBody, serverCallBodyLimit } from "./server-call.js";

/**
 * KOBE-391 ac-1: the gateway's limits for a learning pass's extractor call (`memory_learn`,
 * contract KOBE-390): message length (characters, and bytes through the body cap), message count,
 * the fixed temperature, its own response format only, and the output cap: the token's, the
 * purpose's (reasoning headroom only for a catalog reasoning model), and the model's catalog
 * `max_output_tokens`. The HTTP path (run check, budget, usage row) is in server-call.test.ts.
 */
const LIMITS = SERVER_CALL_LIMITS.memory_learn;
const MODEL = "openai/learner";
const now = Math.floor(Date.now() / 1000);

const claims = (over: Partial<ServerCallClaims> = {}): ServerCallClaims => ({
  iss: "kobe-server",
  aud: SERVER_CALL_AUDIENCE,
  purpose: "memory_learn",
  team_id: randomUUID(),
  user_id: randomUUID(),
  thread_id: randomUUID(),
  run_id: randomUUID(),
  pass_id: randomUUID(),
  model: MODEL,
  max_output_tokens: LIMITS.max_output_tokens,
  iat: now,
  exp: now + 30,
  jti: randomUUID(),
  ...over,
});

const learnBody = (over: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [
    { role: "system", content: "Extract durable facts and preferences as candidates." },
    { role: "user", content: "the thread" },
  ],
  max_tokens: LIMITS.max_output_tokens,
  temperature: 0,
  response_format: SERVER_CALL_RESPONSE_FORMATS.memory_learn,
  ...over,
});

const check = (
  body: unknown,
  c: ServerCallClaims = claims(),
  reasoning = false,
  catalogMax?: number,
) => checkServerCallBody(Buffer.from(JSON.stringify(body)), c, reasoning, catalogMax);

const refused = { ok: false, status: 400, code: "server_call_body_refused" };

describe("memory_learn body limits (KOBE-391 ac-1)", () => {
  it("accepts an extractor call at its limits: longest message, its format, temperature 0", () => {
    const body = learnBody({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "x".repeat(LIMITS.max_message_chars) },
      ],
    });
    expect(check(body)).toEqual({ ok: true, maxOutputTokens: LIMITS.max_output_tokens });
    // The format is optional (the server asks for it only where the provider supports it).
    expect(check(learnBody({ response_format: undefined }))).toMatchObject({ ok: true });
  });

  it("refuses a message longer than the purpose allows", () => {
    const long = "x".repeat(LIMITS.max_message_chars + 1);
    expect(check(learnBody({ messages: [{ role: "user", content: long }] }))).toMatchObject(
      refused,
    );
  });

  it("refuses more than four messages", () => {
    const messages = Array.from({ length: SERVER_CALL_MAX_MESSAGES + 1 }, () => ({
      role: "user",
      content: "m",
    }));
    expect(SERVER_CALL_MAX_MESSAGES).toBe(4);
    expect(check(learnBody({ messages }))).toMatchObject(refused);
    expect(check(learnBody({ messages: messages.slice(0, 4) }))).toMatchObject({ ok: true });
  });

  it("caps the body in bytes as well as characters: 384 KiB whatever the character count", () => {
    expect(serverCallBodyLimit(1 << 20, "memory_learn")).toBe(384 * 1024);
    expect(serverCallBodyLimit(64 * 1024, "memory_learn")).toBe(64 * 1024);
    // Within the character cap, but two bytes a character: above the byte cap (a 413 upstream).
    const wide = "é".repeat(200_000);
    expect(wide.length).toBeLessThanOrEqual(LIMITS.max_message_chars);
    expect(Buffer.byteLength(wide)).toBeGreaterThan(LIMITS.max_body_bytes);
  });

  it("pins the extractor's temperature to 0", () => {
    for (const temperature of [0.2, 1, undefined]) {
      expect(check(learnBody({ temperature })), String(temperature)).toMatchObject(refused);
    }
  });

  it("takes only its own response format", () => {
    expect(
      check(learnBody({ response_format: SERVER_CALL_RESPONSE_FORMATS.eval_judge })),
    ).toMatchObject(refused);
  });

  it("clamps the output to the token's cap, the purpose's cap and the catalog's maxOutputTokens", () => {
    const over = LIMITS.max_output_tokens + 1;
    // Above the token's cap.
    expect(
      check(learnBody({ max_tokens: 4097 }), claims({ max_output_tokens: 4096 })),
    ).toMatchObject(refused);
    // Above the purpose's cap for a model the catalog does not mark as reasoning.
    const big = claims({ max_output_tokens: LIMITS.reasoning_max_output_tokens });
    expect(check(learnBody({ max_tokens: over }), big)).toMatchObject(refused);
    // The reasoning headroom only for a reasoning model.
    expect(check(learnBody({ max_tokens: LIMITS.reasoning_max_output_tokens }), big, true)).toEqual(
      { ok: true, maxOutputTokens: LIMITS.reasoning_max_output_tokens },
    );
    // Clamped to the model's catalog maxOutputTokens, whatever the token says.
    expect(check(learnBody({ max_tokens: 4097 }), claims(), false, 4096)).toMatchObject(refused);
    expect(check(learnBody({ max_tokens: 4096 }), claims(), false, 4096)).toEqual({
      ok: true,
      maxOutputTokens: 4096,
    });
    // A catalog above the purpose's cap changes nothing.
    expect(check(learnBody({ max_tokens: over }), big, false, 100_000)).toMatchObject(refused);
  });

  it("leaves older purposes' caps to their own rules (no catalog clamp)", () => {
    const title = claims({ purpose: "title", pass_id: undefined, max_output_tokens: 64 });
    const body = { ...learnBody(), max_tokens: 64, temperature: 0.2, response_format: undefined };
    expect(check(body, title, false, 32)).toEqual({ ok: true, maxOutputTokens: 64 });
  });
});
