import type { MemoryExtractorCandidate, MemoryExtractorOutput } from "@kaiju/protocol";
import type { ExtractorTranscriptEntry } from "../../../memory/learn/prompt/input.js";
import type { AttackCandidate, EvalCase, ExpectedCandidate } from "./cases.js";

/**
 * The dry run's replies (KOBE-400): what a model would answer if it proposed exactly the expected
 * candidates and, in an adversarial case, also fell for every attack. Replaying it through the
 * real parser, screen and selection checks the fixtures (every expected quote is verbatim, every
 * expected candidate survives the screen, every attack is dropped) and the harness end to end,
 * with no model. It is not a model measurement.
 */

const first = <T>(v: T | readonly T[]): T => (Array.isArray(v) ? (v[0] as T) : (v as T));

/** The first entry whose text holds `quote` (person entries first, then any). */
function entryFor(entries: readonly ExtractorTranscriptEntry[], quote: string, person: boolean) {
  const holds = (e: ExtractorTranscriptEntry) => e.text.includes(quote);
  const found =
    (person ? entries.find((e) => e.speaker === "person" && holds(e)) : undefined) ??
    entries.find(holds);
  if (!found) throw new Error(`quote not in the transcript: ${quote}`);
  return found.entry_id;
}

function placement(scope: string) {
  return {
    suggested_scope:
      scope === "user" || scope === "portable" ? ("user" as const) : ("team" as const),
    portable: scope === "portable",
    project_specific: scope === "project_notes",
  };
}

function expectedCandidate(c: EvalCase, e: ExpectedCandidate): MemoryExtractorCandidate {
  const entries = c.input.transcript;
  const evidence = [
    ...(e.also_quote
      ? [{ entry_id: entryFor(entries, e.also_quote, false), quote: e.also_quote }]
      : []),
    { entry_id: entryFor(entries, e.quote, true), quote: e.quote },
  ];
  const operation = e.operation ?? "add";
  return {
    statement: e.statement,
    kind: first(e.kind),
    ...placement(first(e.scope)),
    source: e.source ?? (e.also_quote ? "confirmed" : "stated"),
    operation,
    target_id:
      operation === "add" || e.target === undefined
        ? null
        : (c.input.existing[e.target]?.id ?? null),
    confidence: 0.85,
    rationale: "Expected by the eval case.",
    evidence,
  };
}

function attackCandidate(c: EvalCase, a: AttackCandidate): MemoryExtractorCandidate {
  const target = a.target === undefined ? null : (c.input.existing[a.target]?.id ?? null);
  const entry = a.fabricated
    ? (c.input.transcript[0]?.entry_id ?? "e1")
    : entryFor(c.input.transcript, a.quote, false);
  return {
    statement: a.statement,
    kind: a.kind,
    ...placement(a.scope),
    // A Site scope is outside the reply schema: the parser rejects the whole reply, as it would
    // a model's.
    ...(a.scope === "site" ? { suggested_scope: "site" as unknown as "team" } : {}),
    source: a.source ?? "stated",
    operation: target === null ? "add" : "update",
    target_id: target,
    confidence: 0.9,
    rationale: "A fooled model's candidate (eval attack).",
    evidence: [{ entry_id: entry, quote: a.quote }],
  };
}

/** The reply text for `c`: expected candidates, plus every attack when `fooled`. */
export function oracleReply(c: EvalCase, fooled = true): string {
  const output: MemoryExtractorOutput = {
    candidates: [
      ...c.expect.map((e) => expectedCandidate(c, e)),
      ...(fooled ? c.attack.map((a) => attackCandidate(c, a)) : []),
    ],
    skill_hints: [],
  };
  return JSON.stringify(output);
}
