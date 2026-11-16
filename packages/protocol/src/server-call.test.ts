import { describe, expect, it } from "vitest";
import {
  EPILOGUE_EVENT_TYPES,
  MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
  MEMORY_LEARN_SCHEMA_RETRIES,
  MEMORY_PASS_MAX_MS,
  PASS_SERVER_CALL_PURPOSES,
  SERVER_CALL_TOKEN_MAX_CHARS,
  RUNLESS_SERVER_CALL_PURPOSES,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_EPILOGUE_MARGIN_MS,
  SERVER_CALL_EPILOGUE_MAX_MS,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PURPOSES,
  SERVER_CALL_REASONING_EFFORT,
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  SERVER_CALL_TOKEN_PURPOSES,
  SKILL_EVAL_JUDGE_RESPONSE_SCHEMA,
  SERVER_CALL_TOKEN_TYP,
  decideStreamOpen,
  epilogueOpen,
  generatedTitleSchema,
  parseEventPayload,
  serverCallBoundToRun,
  serverCallClaimsSchema,
  serverCallNamesPass,
  serverCallOutputCap,
  serverCallOutputCapFor,
  serverCallRequestSchema,
  type KobeEventType,
  type ServerCallClaims,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const NOW = 1_800_000_000;
const CLAIMS: ServerCallClaims = {
  iss: "kobe-server",
  aud: SERVER_CALL_AUDIENCE,
  purpose: "title",
  team_id: EXAMPLE_IDS.team,
  user_id: EXAMPLE_IDS.user,
  thread_id: EXAMPLE_IDS.thread,
  run_id: EXAMPLE_IDS.run,
  model: "openai/gpt-test",
  max_output_tokens: 48,
  iat: NOW,
  exp: NOW + 30,
  jti: "jti-0123456789abcdef",
};
const BODY = {
  model: "openai/gpt-test",
  messages: [
    { role: "system", content: "Title this conversation in at most six words." },
    { role: "user", content: "How did revenue move by region last quarter?" },
  ],
  max_tokens: 48,
};

describe("server-call token", () => {
  it("names its header and an audience no other token carries", () => {
    expect(SERVER_CALL_TOKEN_HEADER).toBe("x-kobe-server-call");
    expect(SERVER_CALL_AUDIENCE).not.toBe("kobe.model-gateway");
    expect(SERVER_CALL_TOKEN_TYP).toBe("ksc2");
  });

  it("bounds the TTL and the output cap per purpose", () => {
    const parse = (over: Partial<ServerCallClaims>) =>
      serverCallClaimsSchema.safeParse({ ...CLAIMS, ...over }).success;
    expect(parse({})).toBe(true);
    expect(parse({ exp: NOW + MAX_SERVER_CALL_TOKEN_TTL_SECONDS + 1 })).toBe(false);
    expect(parse({ exp: NOW })).toBe(false);
    // A reasoning model's call may carry the larger cap (KOBE-219 review H1), never more.
    expect(parse({ max_output_tokens: SERVER_CALL_LIMITS.title.reasoning_max_output_tokens })).toBe(
      true,
    );
    expect(
      parse({ max_output_tokens: SERVER_CALL_LIMITS.title.reasoning_max_output_tokens + 1 }),
    ).toBe(false);
    expect(
      parse({
        purpose: "followups",
        max_output_tokens: SERVER_CALL_LIMITS.followups.reasoning_max_output_tokens + 1,
      }),
    ).toBe(false);
    expect(
      parse({
        purpose: "followups",
        max_output_tokens: SERVER_CALL_LIMITS.followups.max_output_tokens,
      }),
    ).toBe(true);
    expect(parse({ aud: "kobe.model-gateway" as typeof SERVER_CALL_AUDIENCE })).toBe(false);
    expect(parse({ purpose: "chat" as "title" })).toBe(false);
    expect(parse({ max_output_tokens: 10_000 })).toBe(false);
  });

  it("sizes the epilogue window to the longest call plus the margin (calls run concurrently)", () => {
    for (const p of ["title", "followups"] as const) {
      expect(SERVER_CALL_EPILOGUE_MAX_MS).toBeGreaterThanOrEqual(
        SERVER_CALL_LIMITS[p].timeout_ms + SERVER_CALL_EPILOGUE_MARGIN_MS,
      );
    }
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
  });

  it("gives reasoning models a bounded headroom and a low effort (KOBE-219 review H1)", () => {
    for (const p of ["title", "followups"] as const) {
      const l = SERVER_CALL_LIMITS[p];
      expect(l.reasoning_max_output_tokens).toBeGreaterThan(l.max_output_tokens);
      expect(l.reasoning_max_output_tokens).toBeLessThanOrEqual(1024);
    }
    expect(SERVER_CALL_LIMITS.title.reasoning_max_output_tokens).toBe(512);
    expect(SERVER_CALL_REASONING_EFFORT).toBe("low");
  });

  it("refuses format characters in a generated title (bidi, zero-width, line separators)", () => {
    for (const bad of ["Rev\u202Eenue", "Rev\u200Benue", "a\u2028b", "a\u0085b", "\u2066x"]) {
      expect(generatedTitleSchema.safeParse(bad).success).toBe(false);
    }
    expect(generatedTitleSchema.safeParse("Analyse des ventes · Q3 ✓").success).toBe(true);
  });

  it("skips follow-ups at 80 % and titles only at 100 % (CE21)", () => {
    expect(SERVER_CALL_LIMITS.followups.skip_at_percent).toBe(80);
    expect(SERVER_CALL_LIMITS.title.skip_at_percent).toBe(100);
  });

  it("carries the eval judge's purpose, never announced in an epilogue (KOBE-326)", () => {
    const parse = (over: Partial<ServerCallClaims>) =>
      serverCallClaimsSchema.safeParse({ ...CLAIMS, ...over }).success;
    expect(SERVER_CALL_TOKEN_PURPOSES).toEqual([
      "title",
      "followups",
      "eval_judge",
      "skill_manifest",
      "memory_learn",
    ]);
    expect(parse({ purpose: "eval_judge", max_output_tokens: 512 })).toBe(true);
    expect(
      parse({
        purpose: "eval_judge",
        max_output_tokens: SERVER_CALL_LIMITS.eval_judge.reasoning_max_output_tokens + 1,
      }),
    ).toBe(false);
    expect(Object.keys(EPILOGUE_EVENT_TYPES)).toEqual(["title", "followups"]);
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["eval_judge"] }),
    ).toThrow();
    // The judge runs at temperature 0 under its own, longer timeout; epilogue calls keep theirs.
    expect(SERVER_CALL_LIMITS.eval_judge).toMatchObject({
      temperature: 0,
      timeout_ms: 60_000,
      skip_at_percent: 100,
    });
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
  });

  it("carries the skill manifest's purpose without a run or thread, and only that one (KOBE-564)", () => {
    const parse = (claims: Record<string, unknown>) =>
      serverCallClaimsSchema.safeParse(claims).success;
    const { thread_id: _t, run_id: _r, ...runless } = CLAIMS;
    expect(RUNLESS_SERVER_CALL_PURPOSES).toEqual(["skill_manifest"]);
    expect(serverCallBoundToRun("skill_manifest")).toBe(false);
    for (const p of ["title", "followups", "eval_judge"] as const) {
      expect(serverCallBoundToRun(p)).toBe(true);
      // A run-bound purpose always names both.
      expect(parse({ ...runless, purpose: p })).toBe(false);
      expect(parse({ ...CLAIMS, purpose: p, run_id: undefined })).toBe(false);
      expect(parse({ ...CLAIMS, purpose: p, thread_id: undefined })).toBe(false);
    }
    // The manifest call names neither (a member's request, not a run's epilogue).
    expect(parse({ ...runless, purpose: "skill_manifest" })).toBe(true);
    expect(parse({ ...CLAIMS, purpose: "skill_manifest" })).toBe(false);
    expect(parse({ ...runless, purpose: "skill_manifest", run_id: CLAIMS.run_id })).toBe(false);
    expect(parse({ ...runless, purpose: "skill_manifest", thread_id: CLAIMS.thread_id })).toBe(
      false,
    );
    expect(
      parse({
        ...runless,
        purpose: "skill_manifest",
        max_output_tokens: SERVER_CALL_LIMITS.skill_manifest.reasoning_max_output_tokens,
      }),
    ).toBe(true);
    expect(
      parse({
        ...runless,
        purpose: "skill_manifest",
        max_output_tokens: SERVER_CALL_LIMITS.skill_manifest.reasoning_max_output_tokens + 1,
      }),
    ).toBe(false);
    // Never announced in an epilogue; its own caps: one small JSON object from a long SKILL.md.
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["skill_manifest"] }),
    ).toThrow();
    expect(SERVER_CALL_LIMITS.skill_manifest).toMatchObject({
      max_output_tokens: 1024,
      timeout_ms: 60_000,
      skip_at_percent: 100,
    });
    expect(SERVER_CALL_LIMITS.skill_manifest.max_message_chars).toBeGreaterThanOrEqual(100 * 1024);
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
  });
});

describe("memory_learn purpose (KOBE-390)", () => {
  const LEARN: ServerCallClaims = {
    ...CLAIMS,
    purpose: "memory_learn",
    pass_id: "b02b3c4d-5e6f-4a71-8293-a4b5c6d7e8f9",
    max_output_tokens: 8192,
  };
  const parse = (claims: Record<string, unknown>) =>
    serverCallClaimsSchema.safeParse(claims).success;

  it("is a token purpose, run-bound, never an epilogue (ac-2)", () => {
    expect(SERVER_CALL_TOKEN_PURPOSES).toContain("memory_learn");
    expect(SERVER_CALL_PURPOSES as readonly string[]).not.toContain("memory_learn");
    expect(RUNLESS_SERVER_CALL_PURPOSES as readonly string[]).not.toContain("memory_learn");
    expect(serverCallBoundToRun("memory_learn")).toBe(true);
    expect(Object.keys(EPILOGUE_EVENT_TYPES)).toEqual(["title", "followups"]);
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["memory_learn"] }),
    ).toThrow();
  });

  it("names its pass and bound run; no other purpose carries a pass_id", () => {
    expect(PASS_SERVER_CALL_PURPOSES).toEqual(["memory_learn"]);
    expect(parse(LEARN)).toBe(true);
    const { pass_id: _p, ...noPass } = LEARN;
    expect(parse(noPass)).toBe(false);
    expect(parse({ ...LEARN, run_id: undefined })).toBe(false);
    expect(parse({ ...LEARN, thread_id: undefined })).toBe(false);
    expect(parse({ ...LEARN, pass_id: "not-a-uuid" })).toBe(false);
    for (const p of ["title", "followups", "eval_judge"] as const) {
      expect(serverCallNamesPass(p)).toBe(false);
      expect(parse({ ...CLAIMS, purpose: p, max_output_tokens: 48, pass_id: LEARN.pass_id })).toBe(
        false,
      );
    }
  });

  it("keeps the 30 s token cap (no 180 s token)", () => {
    expect(MAX_SERVER_CALL_TOKEN_TTL_SECONDS).toBe(30);
    expect(parse({ ...LEARN, exp: NOW + 30 })).toBe(true);
    expect(parse({ ...LEARN, exp: NOW + 31 })).toBe(false);
    expect(parse({ ...LEARN, exp: NOW + 180 })).toBe(false);
  });

  it("has its own limits: 384 KiB, 300,000 chars, 4 messages, 60 s, 100 %, one retry (ac-2)", () => {
    expect(SERVER_CALL_LIMITS.memory_learn).toEqual({
      max_output_tokens: 8192,
      reasoning_max_output_tokens: 16_384,
      timeout_ms: 60_000,
      skip_at_percent: 100,
      max_message_chars: 300_000,
      max_body_bytes: 384 * 1024,
      temperature: 0,
    });
    expect(MEMORY_LEARN_SCHEMA_RETRIES).toBe(1);
    expect(MEMORY_PASS_MAX_MS).toBe(150_000);
    expect(parse({ ...LEARN, max_output_tokens: 16_384 })).toBe(true);
    expect(parse({ ...LEARN, max_output_tokens: 16_385 })).toBe(false);
    // A 300,000-character message passes the shared request schema; five messages never do.
    const msg = { role: "user", content: "x".repeat(300_000) };
    const body = { model: LEARN.model, messages: [msg], max_tokens: 8192 };
    expect(serverCallRequestSchema.safeParse(body).success).toBe(true);
    expect(
      serverCallRequestSchema.safeParse({ ...body, messages: Array(5).fill(BODY.messages[0]) })
        .success,
    ).toBe(false);
  });

  it("clamps the output cap to the catalog's maxOutputTokens", () => {
    expect(serverCallOutputCap("memory_learn", false)).toBe(8192);
    expect(serverCallOutputCapFor("memory_learn", false, null)).toBe(8192);
    expect(serverCallOutputCapFor("memory_learn", true, undefined)).toBe(16_384);
    expect(serverCallOutputCapFor("memory_learn", true, 4096)).toBe(4096);
    expect(serverCallOutputCapFor("memory_learn", false, 32_000)).toBe(8192);
    expect(serverCallOutputCapFor("title", false, 0)).toBe(1);
  });

  it("fits the token size cap with the longest claims the contract allows", () => {
    const b64 = (s: string) => Math.ceil((Buffer.byteLength(s) * 4) / 3);
    const header = JSON.stringify({ alg: "EdDSA", typ: "ksc2", kid: "k".repeat(22) });
    const payload = JSON.stringify({
      ...LEARN,
      model: `${"p".repeat(64)}/${"m".repeat(191)}`,
      max_output_tokens: 16_384,
      jti: "j".repeat(128),
    });
    // kid: 16 bytes as base64url (keys.ts); Ed25519 signature: 86 base64url characters; two dots.
    expect(b64(header) + b64(payload) + 86 + 2).toBeLessThanOrEqual(SERVER_CALL_TOKEN_MAX_CHARS);
  });
});

describe("existing purposes are unchanged (KOBE-390 ac-3)", () => {
  it("keeps title, followups, eval_judge and skill_manifest as they were", () => {
    expect(SERVER_CALL_PURPOSES).toEqual(["title", "followups"]);
    expect(SERVER_CALL_LIMITS.title).toEqual({
      max_output_tokens: 64,
      reasoning_max_output_tokens: 512,
      timeout_ms: 15_000,
      skip_at_percent: 100,
      max_message_chars: 16_000,
      max_body_bytes: 64 * 1024,
      temperature: 0.2,
    });
    expect(SERVER_CALL_LIMITS.followups).toEqual({
      max_output_tokens: 256,
      reasoning_max_output_tokens: 768,
      timeout_ms: 20_000,
      skip_at_percent: 80,
      max_message_chars: 16_000,
      max_body_bytes: 64 * 1024,
      temperature: 0.2,
    });
    expect(SERVER_CALL_LIMITS.eval_judge).toEqual({
      max_output_tokens: 512,
      reasoning_max_output_tokens: 2048,
      timeout_ms: 60_000,
      skip_at_percent: 100,
      max_message_chars: 400_000,
      max_body_bytes: 2 * 1024 * 1024,
      temperature: 0,
    });
    expect(SERVER_CALL_LIMITS.skill_manifest).toEqual({
      max_output_tokens: 1024,
      reasoning_max_output_tokens: 3072,
      timeout_ms: 60_000,
      skip_at_percent: 100,
      max_message_chars: 120_000,
      max_body_bytes: 512 * 1024,
      temperature: 0.2,
    });
    expect(Object.keys(SERVER_CALL_RESPONSE_FORMATS)).toEqual(["eval_judge", "memory_learn"]);
    expect(SERVER_CALL_RESPONSE_FORMATS.eval_judge.json_schema.name).toBe("skill_eval_verdict");
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
    // An epilogue token with no pass_id still validates exactly as before.
    expect(serverCallClaimsSchema.safeParse(CLAIMS).success).toBe(true);
  });
});

describe("server-call request body", () => {
  const ok = (over: Record<string, unknown>) =>
    serverCallRequestSchema.safeParse({ ...BODY, ...over }).success;

  it("accepts a plain chat completion", () => {
    expect(ok({})).toBe(true);
    expect(
      ok({ max_tokens: undefined, max_completion_tokens: 48, reasoning_effort: "minimal" }),
    ).toBe(true);
  });

  it("refuses tools, tool messages, images, streaming, n > 1 and unknown fields", () => {
    expect(ok({ tools: [{ type: "function", function: { name: "x" } }] })).toBe(false);
    expect(ok({ tool_choice: "auto" })).toBe(false);
    expect(ok({ functions: [] })).toBe(false);
    expect(ok({ messages: [{ role: "tool", content: "x", tool_call_id: "1" }] })).toBe(false);
    expect(ok({ messages: [{ role: "assistant", content: "x", tool_calls: [{ id: "1" }] }] })).toBe(
      false,
    );
    expect(ok({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toBe(false);
    expect(ok({ stream: true })).toBe(false);
    expect(ok({ n: 2 })).toBe(false);
    expect(ok({ web_search_options: {} })).toBe(false);
  });

  it("takes a long message and the judge's structured format by shape (the gateway checks the purpose)", () => {
    const long = "x".repeat(SERVER_CALL_LIMITS.eval_judge.max_message_chars);
    expect(ok({ messages: [{ role: "user", content: long }] })).toBe(true);
    expect(ok({ messages: [{ role: "user", content: `${long}x` }] })).toBe(false);
    expect(ok({ response_format: SERVER_CALL_RESPONSE_FORMATS.eval_judge })).toBe(true);
    expect(SERVER_CALL_RESPONSE_FORMATS.eval_judge.json_schema.schema).toBe(
      SKILL_EVAL_JUDGE_RESPONSE_SCHEMA,
    );
    expect(ok({ response_format: { type: "json_object" } })).toBe(false);
    expect(
      ok({
        response_format: {
          ...SERVER_CALL_RESPONSE_FORMATS.eval_judge,
          json_schema: { name: "v", strict: false, schema: {} },
        },
      }),
    ).toBe(false);
  });

  it("needs exactly one output limit", () => {
    expect(ok({ max_tokens: undefined })).toBe(false);
    expect(ok({ max_completion_tokens: 48 })).toBe(false);
  });
});

describe("epilogue events", () => {
  it("validates thread.updated and thread.suggestions, and run.completed.epilogue", () => {
    expect(
      parseEventPayload("thread.updated", { thread_id: EXAMPLE_IDS.thread, title: "Revenue" }),
    ).toEqual({ thread_id: EXAMPLE_IDS.thread, title: "Revenue" });
    expect(() =>
      parseEventPayload("thread.updated", { thread_id: EXAMPLE_IDS.thread, title: "a\nb" }),
    ).toThrow();
    expect(() =>
      parseEventPayload("thread.suggestions", {
        thread_id: EXAMPLE_IDS.thread,
        suggestions: ["a", "b", "c", "d"],
      }),
    ).toThrow();
    expect(
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["title", "followups"] })
        .epilogue,
    ).toEqual(["title", "followups"]);
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["title", "title"] }),
    ).toThrow();
  });

  it("keeps the stream open until each announced result arrived or the deadline", () => {
    const at = 1_000_000;
    const written = (...t: KobeEventType[]) => new Set<KobeEventType>(t);
    const open = (
      epilogue: ("title" | "followups")[] | undefined,
      w: Set<KobeEventType>,
      now = at,
    ) => epilogueOpen({ epilogue, written: w, completedAtMs: at, nowMs: now });
    expect(open(undefined, written())).toBe(false);
    expect(open(["title"], written())).toBe(true);
    expect(open(["title"], written(EPILOGUE_EVENT_TYPES.title))).toBe(false);
    expect(open(["title", "followups"], written("thread.updated"))).toBe(true);
    expect(open(["title"], written(), at + SERVER_CALL_EPILOGUE_MAX_MS)).toBe(false);
    const base = { ended: true, events_compacted: false, last_seq: 9, cursor: 9 };
    expect(decideStreamOpen(base)).toEqual({ kind: "no_content" });
    expect(decideStreamOpen({ ...base, epilogue_open: true })).toEqual({ kind: "stream" });
    expect(decideStreamOpen({ ...base, events_compacted: true, epilogue_open: true })).toEqual({
      kind: "gone",
    });
  });
});
