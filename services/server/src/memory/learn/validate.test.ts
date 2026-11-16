import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMemoryExtractorOutput,
  type MemoryExtractorCandidate,
  type MemoryExtractorOutput,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { extractorPromptInputSchema, type ExtractorPromptInput } from "./prompt/input.js";
import { screenExtractorOutput, type ScreenedCandidate } from "./screen.js";
import {
  LEARN_MAX_CANDIDATES,
  LEARN_MIN_CONFIDENCE,
  selectCandidates,
  statementHash,
  type KnownStatements,
} from "./validate.js";

/** KOBE-393 ac-1: every selection rule, alone and on the recorded replies (KOBE-394 fixtures). */

const NONE: KnownStatements = { open: new Set(), dismissed: new Set() };

const candidate = (over: Partial<MemoryExtractorCandidate> = {}): MemoryExtractorCandidate => ({
  statement: "I prefer metric units.",
  kind: "preference",
  suggested_scope: "user",
  portable: false,
  project_specific: false,
  source: "stated",
  operation: "add",
  target_id: null,
  confidence: 0.8,
  rationale: "The person said so.",
  evidence: [{ entry_id: "e1", quote: "metric units" }],
  ...over,
});
const screened = (
  over: Partial<MemoryExtractorCandidate> = {},
  destination: ScreenedCandidate["destination"] = "user",
): ScreenedCandidate => ({ candidate: candidate(over), destination });

describe("statementHash", () => {
  it("is the same for statements that read the same, and lowercase hex", () => {
    const h = statementHash("I prefer “metric” units.");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(statementHash('  i PREFER "metric"​   units. ')).toBe(h);
    expect(statementHash("I prefer imperial units.")).not.toBe(h);
  });
});

describe("selectCandidates rules", () => {
  it("drops an inferred candidate bound for the Workspace or a project's Notes", () => {
    const r = selectCandidates(
      [
        screened({ source: "inferred", statement: "a" }, "team"),
        screened({ source: "inferred", statement: "b" }, "project_notes"),
        screened({ source: "inferred", statement: "c" }, "portable"),
      ],
      NONE,
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(["inferred_shared", "inferred_shared"]);
    expect(r.selected.map((s) => s.candidate.statement)).toEqual(["c"]);
  });

  it(`drops confidence under ${LEARN_MIN_CONFIDENCE} and keeps it at the bound`, () => {
    const r = selectCandidates(
      [
        screened({ confidence: 0.39, statement: "low" }),
        screened({ confidence: LEARN_MIN_CONFIDENCE, statement: "edge" }),
      ],
      NONE,
    );
    expect(r.dropped).toEqual([{ statement: "low", reason: "low_confidence" }]);
    expect(r.selected.map((s) => s.candidate.statement)).toEqual(["edge"]);
  });

  it("drops statements already open for review or dismissed before", () => {
    const known = {
      open: new Set([statementHash("Open one.")]),
      dismissed: new Set([statementHash("dismissed ONE.")]),
    };
    const r = selectCandidates(
      [screened({ statement: "open one." }), screened({ statement: "Dismissed one." })],
      known,
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(["already_open", "dismissed"]);
    expect(r.selected).toEqual([]);
  });

  it("keeps the more confident copy of a repeated statement", () => {
    const r = selectCandidates(
      [
        screened({ statement: "Same thing.", confidence: 0.5, rationale: "weak" }),
        screened({ statement: "same  thing.", confidence: 0.9, rationale: "strong" }),
      ],
      NONE,
    );
    expect(r.selected.map((s) => s.candidate.rationale)).toEqual(["strong"]);
    expect(r.dropped).toEqual([{ statement: "Same thing.", reason: "duplicate_in_reply" }]);
  });

  it(`keeps at most ${LEARN_MAX_CANDIDATES}, most confident first, ties in reply order`, () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      screened({ statement: `s${i}`, confidence: i < 2 ? 0.95 : 0.5 + i / 100 }),
    );
    const r = selectCandidates(many, NONE);
    expect(r.selected).toHaveLength(LEARN_MAX_CANDIDATES);
    expect(r.selected.slice(0, 3).map((s) => s.candidate.statement)).toEqual(["s0", "s1", "s13"]);
    expect(r.dropped.filter((d) => d.reason === "over_limit").map((d) => d.statement)).toEqual([
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
    const confidences = r.selected.map((s) => s.candidate.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });
});

describe("recorded replies through parse, screen and select", () => {
  const DIR = join(import.meta.dirname, "prompt", "v1", "fixtures");
  const names = readdirSync(DIR).filter((f) => f.endsWith(".json"));

  it.each(names)("%s", (name) => {
    const f = JSON.parse(readFileSync(join(DIR, name), "utf8")) as {
      adversarial: boolean;
      input: unknown;
      reply: unknown;
    };
    const input: ExtractorPromptInput = extractorPromptInputSchema.parse(f.input);
    const parsed = parseMemoryExtractorOutput(
      typeof f.reply === "string" ? f.reply : JSON.stringify(f.reply),
    );
    if (!parsed.ok) return; // the schema reject path: the pass retries once, then fails
    const output: MemoryExtractorOutput = parsed.output;
    const screen = screenExtractorOutput(output, input);
    const r = selectCandidates(screen.kept, NONE);
    expect(r.selected.length).toBeLessThanOrEqual(LEARN_MAX_CANDIDATES);
    expect(r.selected.length + r.dropped.length).toBe(screen.kept.length);
    for (const s of r.selected) {
      expect(s.candidate.confidence).toBeGreaterThanOrEqual(LEARN_MIN_CONFIDENCE);
      if (s.candidate.source === "inferred") expect(["user", "portable"]).toContain(s.destination);
    }
    if (f.adversarial)
      expect(
        r.selected.filter((s) => s.destination === "team" || s.destination === "project_notes"),
      ).toEqual([]);
    // Running the pass again over the same thread offers nothing it already holds open.
    const again = selectCandidates(screen.kept, {
      open: new Set(r.selected.map((s) => s.hash)),
      dismissed: new Set(),
    });
    expect(again.selected).toEqual([]);
  });
});
