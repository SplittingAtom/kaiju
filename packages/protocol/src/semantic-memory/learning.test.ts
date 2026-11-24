import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KAIJU_EVENT_TYPES,
  MEMORY_CANDIDATE_SCOPES,
  MEMORY_EXTRACTOR_RESPONSE_SCHEMA,
  MEMORY_PASS_EVENT_TYPES,
  RESERVED_MEMORY_AUDIT_ACTIONS,
  SEMANTIC_MEMORY_KINDS,
  SERVER_CALL_RESPONSE_FORMATS,
  kaijuEventSchema,
  memoryExtractorOutputSchema,
  parseEventPayload,
  parseMemoryExtractorOutput,
} from "../index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const raw = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const fixture = (name: string): unknown => JSON.parse(raw(`${name}.json`));

const INVALID = readdirSync(FIXTURES)
  .filter((f) => f.startsWith("extractor-invalid-"))
  .map((f) => f.replace(/\.json$/, ""));

describe("extractor output schema (KOBE-390 ac-1)", () => {
  it.each(["extractor-output", "extractor-output-empty"])("golden %s parses unchanged", (name) => {
    const value = fixture(name);
    const parsed = memoryExtractorOutputSchema.safeParse(value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(value);
  });

  it("has invalid fixtures for each rule", () => {
    expect(INVALID.length).toBeGreaterThanOrEqual(12);
  });

  it.each(INVALID)("refuses %s", (name) => {
    expect(memoryExtractorOutputSchema.safeParse(fixture(name)).success).toBe(false);
    expect(parseMemoryExtractorOutput(raw(`${name}.json`))).toEqual({
      ok: false,
      reason: "schema_rejected",
    });
  });

  it("parses a reply alone or in one fenced block, and nothing else", () => {
    const json = raw("extractor-output.json").trim();
    const value = fixture("extractor-output");
    expect(parseMemoryExtractorOutput(json)).toEqual({ ok: true, output: value });
    expect(parseMemoryExtractorOutput("```json\n" + json + "\n```")).toEqual({
      ok: true,
      output: value,
    });
    for (const bad of ["", "Here you go: " + json, "```\n" + json + "\n```\n```\n{}\n```", "[]"]) {
      expect(parseMemoryExtractorOutput(bad)).toEqual({ ok: false, reason: "schema_rejected" });
    }
  });

  it("never suggests the Site and keeps the JSON schema in step with the zod schema", () => {
    expect(MEMORY_CANDIDATE_SCOPES).toEqual(["user", "team"]);
    const item = MEMORY_EXTRACTOR_RESPONSE_SCHEMA.properties.candidates.items;
    const zodShape = Object.keys(memoryExtractorOutputSchema.shape.candidates.element.shape).sort();
    expect([...item.required].sort()).toEqual(zodShape);
    expect(Object.keys(item.properties).sort()).toEqual(zodShape);
    expect(item.properties.kind.enum).toEqual(SEMANTIC_MEMORY_KINDS);
    expect(item.properties.suggested_scope.enum).not.toContain("site");
    expect(
      [...MEMORY_EXTRACTOR_RESPONSE_SCHEMA.required].sort(),
      "top-level keys required",
    ).toEqual(Object.keys(memoryExtractorOutputSchema.shape).sort());
    expect(SERVER_CALL_RESPONSE_FORMATS.memory_learn.json_schema).toEqual({
      name: "memory_extractor",
      strict: true,
      schema: MEMORY_EXTRACTOR_RESPONSE_SCHEMA,
    });
  });

  it("names no model anywhere in the contract", () => {
    const text = JSON.stringify(MEMORY_EXTRACTOR_RESPONSE_SCHEMA) + raw("../learning.ts");
    expect(text).not.toMatch(/glm|gpt|claude|llama|qwen|gemini/i);
  });
});

describe("pass events (KOBE-390)", () => {
  it("are Kaiju event types after the epilogue's", () => {
    expect(KAIJU_EVENT_TYPES.slice(-3)).toEqual([...MEMORY_PASS_EVENT_TYPES]);
  });

  it.each(["pass-progress-event", "pass-completed-event", "pass-failed-event"])(
    "golden %s parses as an event envelope",
    (name) => {
      const value = fixture(name);
      const parsed = kaijuEventSchema.safeParse(value);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data).toEqual(value);
    },
  );

  it("refuses unknown stages, failure codes and counts past the caps", () => {
    const p = {
      pass_id: "b02b3c4d-5e6f-4a71-8293-a4b5c6d7e8f9",
      thread_id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60",
    };
    expect(() => parseEventPayload("memory.pass.progress", { ...p, stage: "saving" })).toThrow();
    expect(() =>
      parseEventPayload("memory.pass.failed", {
        ...p,
        code: "oops",
        message: "x",
        retryable: true,
      }),
    ).toThrow();
    expect(() =>
      parseEventPayload("memory.pass.completed", {
        ...p,
        candidates: 21,
        dropped: 0,
        skill_hints: 0,
      }),
    ).toThrow();
    expect(() =>
      parseEventPayload("memory.pass.completed", {
        ...p,
        candidates: 0,
        dropped: 0,
        skill_hints: 3,
      }),
    ).toThrow();
  });

  it("has audit names reserved for passes, candidates, proposals and suggestions", () => {
    for (const a of [
      "memory.pass.started",
      "memory.pass.completed",
      "memory.pass.failed",
      "memory.candidate.accepted",
      "memory.candidate.dismissed",
      "memory.proposal.created",
      "memory.suggestion.created",
    ])
      expect(RESERVED_MEMORY_AUDIT_ACTIONS as readonly string[]).toContain(a);
  });
});
