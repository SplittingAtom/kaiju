import type {
  MemoryExtractorCandidate,
  MemoryExtractorOutput,
  MemorySkillHint,
} from "@kobe/protocol";
import { capitalisedWords, findPersonalData, namesNearSensitiveData } from "../checks/personal.js";
import { lintInstructions } from "../checks/lint.js";
import { findSecret } from "../checks/secrets.js";
import { quoteFoundIn } from "../quote-normalise.js";
import { mentionsCapabilityChange, quoteAsksCapabilityChange } from "./capability.js";
import { listedExistingItems } from "./prompt/build.js";
import type { ExtractorPromptInput, ExtractorSpeaker } from "./prompt/input.js";

/**
 * The pure part of a pass's candidate validation (KOBE-394; SMB5/KOBE-393 runs it on every parsed
 * extractor reply before its database checks: dismissals, near-duplicates, Policy conflicts).
 * It needs no model and no database, so CI replays recorded replies through it.
 *
 * A candidate is dropped, with the first reason that applies, when:
 *
 * - `evidence_not_found`: a quote cites no transcript entry or is not a verbatim span of it
 *   (normalised as `quoteFoundIn`, exact case);
 * - `person_evidence_missing`: no quote comes from the person (an assistant claim, a tool result
 *   or a summary alone never makes a memory);
 * - `shared_evidence_not_person`: a Workspace candidate also quotes tool output or a summary;
 * - `unknown_target` / `policy_target`: `target_id` is not one of the items the prompt listed
 *   (`listedExistingItems`), or is a Policy item;
 * - `secret`: the statement, rationale or a quote holds a credential;
 * - `instruction`: the statement or rationale reads as an instruction to the agent
 *   (memory/checks lint);
 * - `capability_change`: the statement or a quote asks for (or reports a wish for) a change to
 *   what the agent may do: internet or egress access, approvals, tool or connector permissions,
 *   sandbox settings (`capability.ts`, KOBE-660; memory cannot change those, at any scope);
 * - `personal_data`: the statement carries personal data, or names someone a cited entry
 *   discusses personal data about (KOBE-660: "Do not share drafts with Priya" from "Priya's
 *   husband works at our competitor"), at any scope: other people's details never become
 *   memories, personal ones included, nor do statements built on them. A name alone is fine
 *   ("Anna owns the Q3 report");
 * - `project_without_project`: a Workspace candidate is project-specific but the thread has no
 *   project.
 *
 * Skill hints holding a credential or reading as an instruction are left out.
 *
 * A survivor gets its destination: `user`, `portable`, `team`, or `project_notes` for a
 * project-specific Workspace candidate (project facts go to the project's Notes, not Workspace
 * memories). Never `site`: the schema has no such scope.
 */

export const SCREEN_DROP_REASONS = [
  "evidence_not_found",
  "person_evidence_missing",
  "shared_evidence_not_person",
  "unknown_target",
  "policy_target",
  "secret",
  "instruction",
  "capability_change",
  "personal_data",
  "project_without_project",
] as const;
export type ScreenDropReason = (typeof SCREEN_DROP_REASONS)[number];

export type CandidateDestination = "user" | "portable" | "team" | "project_notes";

export interface ScreenedCandidate {
  readonly candidate: MemoryExtractorCandidate;
  readonly destination: CandidateDestination;
}

export interface ScreenResult {
  readonly kept: readonly ScreenedCandidate[];
  /** Index into the reply's `candidates` and why it was dropped. */
  readonly dropped: readonly { readonly index: number; readonly reason: ScreenDropReason }[];
  readonly skill_hints: readonly MemorySkillHint[];
}

type Verdict =
  | { readonly ok: true; readonly destination: CandidateDestination }
  | { readonly ok: false; readonly reason: ScreenDropReason };

interface Context {
  readonly entries: ReadonlyMap<string, { speaker: ExtractorSpeaker; text: string }>;
  readonly items: ReadonlyMap<string, { policy: boolean }>;
  readonly hasProject: boolean;
}

const SHARED_SPEAKERS: ReadonlySet<ExtractorSpeaker> = new Set(["person", "assistant"]);

function evidenceReason(c: MemoryExtractorCandidate, ctx: Context): ScreenDropReason | null {
  const speakers: ExtractorSpeaker[] = [];
  for (const e of c.evidence) {
    const entry = ctx.entries.get(e.entry_id);
    if (!entry || !quoteFoundIn(e.quote, entry.text)) return "evidence_not_found";
    speakers.push(entry.speaker);
  }
  if (!speakers.includes("person")) return "person_evidence_missing";
  if (c.suggested_scope === "team" && speakers.some((s) => !SHARED_SPEAKERS.has(s)))
    return "shared_evidence_not_person";
  return null;
}

const instructs = (text: string): boolean => lintInstructions(text).length > 0;
const unsafe = (text: string): boolean => findSecret(text) !== undefined || instructs(text);

/** The statement names someone a cited entry discusses personal data about. */
function namesSensitivePerson(c: MemoryExtractorCandidate, ctx: Context): boolean {
  const named = capitalisedWords(c.statement);
  if (named.size === 0) return false;
  return c.evidence.some((e) => {
    const entry = ctx.entries.get(e.entry_id);
    return entry !== undefined && [...namesNearSensitiveData(entry.text)].some((w) => named.has(w));
  });
}

function contentReason(c: MemoryExtractorCandidate, ctx: Context): ScreenDropReason | null {
  const texts = [c.statement, c.rationale, ...c.evidence.map((e) => e.quote)];
  if (texts.some((t) => findSecret(t) !== undefined)) return "secret";
  if ([c.statement, c.rationale].some(instructs)) return "instruction";
  // Not the rationale: it may say why a request is left out of the statement.
  if (
    mentionsCapabilityChange(c.statement) ||
    c.evidence.some((e) => quoteAsksCapabilityChange(e.quote))
  )
    return "capability_change";
  if (findPersonalData(c.statement).length > 0 || namesSensitivePerson(c, ctx))
    return "personal_data";
  return null;
}

function verdictFor(c: MemoryExtractorCandidate, ctx: Context): Verdict {
  const evidence = evidenceReason(c, ctx);
  if (evidence) return { ok: false, reason: evidence };
  if (c.target_id !== null) {
    const target = ctx.items.get(c.target_id);
    if (!target) return { ok: false, reason: "unknown_target" };
    if (target.policy) return { ok: false, reason: "policy_target" };
  }
  const content = contentReason(c, ctx);
  if (content) return { ok: false, reason: content };
  if (c.suggested_scope === "user")
    return { ok: true, destination: c.portable ? "portable" : "user" };
  if (!c.project_specific) return { ok: true, destination: "team" };
  return ctx.hasProject
    ? { ok: true, destination: "project_notes" }
    : { ok: false, reason: "project_without_project" };
}

/** Screens a parsed extractor reply against the pass's input. */
export function screenExtractorOutput(
  output: MemoryExtractorOutput,
  input: ExtractorPromptInput,
): ScreenResult {
  const ctx: Context = {
    // A placeholder (a body the pass could not read) is never evidence (KOBE-392).
    entries: new Map(input.transcript.filter((e) => !e.placeholder).map((e) => [e.entry_id, e])),
    items: new Map(listedExistingItems(input).map((i) => [i.id, i])),
    hasProject: input.project !== null,
  };
  const kept: ScreenedCandidate[] = [];
  const dropped: { index: number; reason: ScreenDropReason }[] = [];
  output.candidates.forEach((candidate, index) => {
    const v = verdictFor(candidate, ctx);
    if (v.ok) kept.push({ candidate, destination: v.destination });
    else dropped.push({ index, reason: v.reason });
  });
  // A skill hint is shown to the author too: one carrying a credential or an order is left out.
  const skill_hints = output.skill_hints.filter((h) => !unsafe(h.title) && !unsafe(h.summary));
  return { kept, dropped, skill_hints };
}
