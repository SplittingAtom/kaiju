import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MEMORY_CANDIDATE_SOURCES,
  MEMORY_CANDIDATE_OPERATIONS,
  SEMANTIC_MEMORY_KINDS,
  semanticMemoryScopeSchema,
} from "@kobe/protocol";
import {
  extractorPromptInputSchema,
  extractorSpeakerSchema,
  type ExtractorPromptInput,
} from "../../../memory/learn/prompt/input.js";
import type { CandidateDestination } from "../../../memory/learn/screen.js";

/**
 * The extractor eval's seeded transcripts (KOBE-400, spec U52): `e2e/fixtures/memory-extractor/
 * cases/*.json`, each file `{ "cases": [...] }`. A case is a pass input written compactly
 * (transcript entries as `[speaker, text]`, given ids `e1`, `e2`, ...) plus what a good extractor
 * should propose (`expect`), what it may propose without being wrong (`allow`) and, for an
 * adversarial case, what it must never propose (`forbid`, and `attack`: the candidates a fooled
 * model would reply with, which the server's screen must drop). The README there explains how to
 * write one.
 */

export const DESTINATIONS = [
  "user",
  "portable",
  "team",
  "project_notes",
] as const satisfies readonly CandidateDestination[];
const destination = z.enum(DESTINATIONS);
const kind = z.enum(SEMANTIC_MEMORY_KINDS);
const oneOrMany = <T extends z.ZodType>(t: T) => z.union([t, z.array(t).min(1)]);

/**
 * A match pattern: every term must occur in the normalised statement; a term that is a list
 * matches when any of its alternatives occurs.
 */
const pattern = z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).min(1);
export type MatchPattern = z.infer<typeof pattern>;

export const CASE_CATEGORIES = [
  "preference",
  "workspace",
  "project",
  "existing",
  "nothing",
  "branch",
  "fork",
  "adversarial",
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

const expectedSchema = z.strictObject({
  /** A statement a good extractor would write (the dry run's reply uses it). */
  statement: z.string().min(1).max(500),
  match: pattern,
  kind: oneOrMany(kind),
  scope: oneOrMany(destination),
  /** Verbatim text of the entry the evidence comes from (the person's, unless `quote_from`). */
  quote: z.string().min(1).max(200),
  /** Extra evidence (e.g. the assistant's question a person confirmed). */
  also_quote: z.string().min(1).max(200).optional(),
  source: z.enum(MEMORY_CANDIDATE_SOURCES).optional(),
  operation: z.enum(MEMORY_CANDIDATE_OPERATIONS).optional(),
  /** Index into the case's `existing` for update, supersede and conflict. */
  target: z.number().int().min(0).optional(),
});
export type ExpectedCandidate = z.infer<typeof expectedSchema>;

const attackSchema = z.strictObject({
  statement: z.string().min(1).max(500),
  kind,
  /**
   * What the fooled model asks for: a destination, or `site` (which the reply schema refuses, so
   * the whole reply is rejected).
   */
  scope: z.enum(["user", "portable", "team", "project_notes", "site"]),
  quote: z.string().min(1).max(200),
  source: z.enum(MEMORY_CANDIDATE_SOURCES).optional(),
  /** The quote is invented: cited on the first entry, where it does not occur. */
  fabricated: z.boolean().optional(),
  /** Index into `existing`: the attack updates that item (a Policy item, say). */
  target: z.number().int().min(0).optional(),
});
export type AttackCandidate = z.infer<typeof attackSchema>;

const existingSchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  kind,
  policy: z.boolean().optional(),
  statement: z.string().min(1).max(500),
});

const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1),
  adversarial: z.boolean().optional(),
  project: z.string().min(1).max(200).nullable().optional(),
  existing: z.array(existingSchema).optional(),
  transcript: z.array(z.tuple([extractorSpeakerSchema, z.string().min(1)])).min(1),
  expect: z.array(expectedSchema),
  allow: z.array(pattern).optional(),
  forbid: z.array(pattern).optional(),
  attack: z.array(attackSchema).optional(),
});
type RawCase = z.infer<typeof caseSchema>;

const fileSchema = z.strictObject({ cases: z.array(caseSchema).min(1) });

export interface EvalCase {
  readonly id: string;
  readonly category: CaseCategory;
  readonly description: string;
  readonly adversarial: boolean;
  readonly input: ExtractorPromptInput;
  readonly expect: readonly ExpectedCandidate[];
  readonly allow: readonly MatchPattern[];
  readonly forbid: readonly MatchPattern[];
  readonly attack: readonly AttackCandidate[];
}

/** Deterministic uuid for the n-th existing item of a case (fixtures stay readable). */
export const existingItemId = (caseIndex: number, n: number): string =>
  `00000000-0000-4000-8${String(caseIndex).padStart(3, "0")}-${String(n).padStart(12, "0")}`;

export const entryId = (n: number): string => `e${n + 1}`;

function toCase(raw: RawCase, category: CaseCategory, caseIndex: number): EvalCase {
  const input = extractorPromptInputSchema.parse({
    project: raw.project ? { name: raw.project } : null,
    existing: (raw.existing ?? []).map((e, n) => ({
      id: existingItemId(caseIndex, n),
      scope: e.scope,
      kind: e.kind,
      policy: e.policy ?? false,
      statement: e.statement,
    })),
    transcript: raw.transcript.map(([speaker, text], n) => ({
      entry_id: entryId(n),
      speaker,
      text,
    })),
  });
  return {
    id: raw.id,
    category,
    description: raw.description,
    adversarial: raw.adversarial ?? category === "adversarial",
    input,
    expect: raw.expect,
    allow: raw.allow ?? [],
    forbid: raw.forbid ?? [],
    attack: raw.attack ?? [],
  };
}

/** Parses one cases file; its name (without `.json`) is the category. */
export function parseCasesFile(category: string, json: unknown, firstIndex = 0): EvalCase[] {
  const cat = z.enum(CASE_CATEGORIES).parse(category);
  return fileSchema.parse(json).cases.map((c, i) => toCase(c, cat, firstIndex + i));
}

/**
 * Every case under `dir` (`<category>.json`), in file then case order. Throws on a duplicate id,
 * an adversarial case without `forbid`, or a target index outside `existing`.
 */
export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    const json: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
    cases.push(...parseCasesFile(f.slice(0, -".json".length), json, cases.length));
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    if (c.adversarial && c.forbid.length === 0)
      problems.push(`${c.id}: adversarial without forbid`);
    for (const e of [...c.expect, ...c.attack])
      if (e.target !== undefined && e.target >= c.input.existing.length)
        problems.push(`${c.id}: target ${e.target} is not an existing item`);
  }
  if (problems.length > 0) throw new Error(`extractor cases:\n${problems.join("\n")}`);
  return cases;
}
