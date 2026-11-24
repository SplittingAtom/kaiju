import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  SEMANTIC_MEMORY_KINDS,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  codePointLength,
  semanticMemoryKindSchema,
  semanticMemoryStatementSchema,
} from "./fields.js";

/**
 * Learning passes (KOBE-390 contract, spec SM14/SM15, Phase B). A thread author asks Kaiju to learn
 * from a conversation; the server runs one **pass** on BackgroundTasks: it reads the thread up to
 * the leaf, asks the Workspace's learning model (a Site setting with Workspace override, like the
 * eval judge's; never a fallback to another model: `memory_learning_model_unavailable`) for
 * candidates through the `memory_learn` server call (server-call.ts), checks them (memory/checks),
 * and stores the survivors as candidates the author reviews. Nothing is saved without the author.
 *
 * The extractor's reply is {@link memoryExtractorOutputSchema}: asked for with the structured
 * format {@link MEMORY_EXTRACTOR_RESPONSE_SCHEMA} where the provider supports it, and parsed with
 * {@link parseMemoryExtractorOutput} in every case. A reply that fails the schema is retried once
 * ({@link MEMORY_LEARN_SCHEMA_RETRIES}); a second failure fails the pass (`schema_rejected`).
 * Nothing in this contract names a model. Audit names for passes, candidates, proposals and
 * suggestions are `RESERVED_MEMORY_AUDIT_ACTIONS` (governance.ts).
 */

/** Most candidates one extractor reply may carry (more fails the schema). */
export const MEMORY_EXTRACTOR_MAX_CANDIDATES = 20;
/** Evidence quotes per candidate: at least one, at most three. */
export const MEMORY_EXTRACTOR_EVIDENCE_MIN = 1;
export const MEMORY_EXTRACTOR_EVIDENCE_MAX = 3;
/** Longest evidence quote, in code points (a verbatim span of the cited entry). */
export const MEMORY_EXTRACTOR_QUOTE_MAX = 200;
/** Longest rationale, in code points (shown to the reviewer; never leaves the Workspace). */
export const MEMORY_EXTRACTOR_RATIONALE_MAX = 500;
/** Skill hints per reply ("this procedure could be a skill"). */
export const MEMORY_EXTRACTOR_SKILL_HINTS_MAX = 2;
export const MEMORY_EXTRACTOR_SKILL_HINT_TITLE_MAX = 80;
export const MEMORY_EXTRACTOR_SKILL_HINT_SUMMARY_MAX = 300;
/** A reply that fails the schema is asked for again this many times, then the pass fails. */
export const MEMORY_LEARN_SCHEMA_RETRIES = 1;

/**
 * Where the extractor suggests keeping a candidate: the person (`user`) or the Workspace (`team`).
 * Never `site`: only a Team admin's confirmation moves a statement to the Site. A personal
 * preference that should follow the person across Workspaces is `user` with `portable: true`.
 */
export const MEMORY_CANDIDATE_SCOPES = ["user", "team"] as const;
export const memoryCandidateScopeSchema = z.enum(MEMORY_CANDIDATE_SCOPES);
export type MemoryCandidateScope = z.infer<typeof memoryCandidateScopeSchema>;

/**
 * How the conversation supports the candidate: the person said it (`stated`), the person agreed
 * to something the assistant said (`confirmed`), or the extractor concluded it (`inferred`).
 * Inferred candidates are personal only (`suggested_scope: user`); Workspace candidates need the
 * person's own words.
 */
export const MEMORY_CANDIDATE_SOURCES = ["stated", "confirmed", "inferred"] as const;
export const memoryCandidateSourceSchema = z.enum(MEMORY_CANDIDATE_SOURCES);
export type MemoryCandidateSource = z.infer<typeof memoryCandidateSourceSchema>;

/**
 * What the candidate does to memory: a new item (`add`), a new version of `target_id`
 * (`update`), a replacement that supersedes `target_id` (`supersede`), or a contradiction of
 * `target_id` the reviewer resolves (`conflict`). Only `add` names no target.
 */
export const MEMORY_CANDIDATE_OPERATIONS = ["add", "update", "supersede", "conflict"] as const;
export const memoryCandidateOperationSchema = z.enum(MEMORY_CANDIDATE_OPERATIONS);
export type MemoryCandidateOperation = z.infer<typeof memoryCandidateOperationSchema>;

const boundedText = (max: number, what: string) =>
  z
    .string()
    .refine((s) => s.trim().length > 0, { message: `${what} is blank` })
    .refine((s) => codePointLength(s) <= max, { message: `${what} exceeds ${max} characters` });

/** One quote from a thread entry; the server checks it is a verbatim span of that entry. */
export const memoryEvidenceSchema = z.strictObject({
  entry_id: idSchema,
  quote: boundedText(MEMORY_EXTRACTOR_QUOTE_MAX, "quote"),
});
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;

export const memoryExtractorCandidateSchema = z
  .strictObject({
    statement: semanticMemoryStatementSchema,
    kind: semanticMemoryKindSchema,
    suggested_scope: memoryCandidateScopeSchema,
    /** A personal preference that follows the person across Workspaces (`user` scope only). */
    portable: z.boolean(),
    /** True when the statement holds only for the thread's project. */
    project_specific: z.boolean(),
    source: memoryCandidateSourceSchema,
    operation: memoryCandidateOperationSchema,
    /** The existing item the operation acts on; null exactly when `operation` is `add`. */
    target_id: uuidSchema.nullable(),
    confidence: z.number().min(0).max(1),
    rationale: boundedText(MEMORY_EXTRACTOR_RATIONALE_MAX, "rationale"),
    evidence: z
      .array(memoryEvidenceSchema)
      .min(MEMORY_EXTRACTOR_EVIDENCE_MIN)
      .max(MEMORY_EXTRACTOR_EVIDENCE_MAX),
  })
  .refine((c) => (c.operation === "add") === (c.target_id === null), {
    message: "target_id is null for add and names an item otherwise",
    path: ["target_id"],
  })
  .refine((c) => c.source !== "inferred" || c.suggested_scope === "user", {
    message: "an inferred candidate is personal only",
    path: ["suggested_scope"],
  })
  .refine((c) => !c.portable || c.suggested_scope === "user", {
    message: "only a personal candidate is portable",
    path: ["portable"],
  });
export type MemoryExtractorCandidate = z.infer<typeof memoryExtractorCandidateSchema>;

export const memorySkillHintSchema = z.strictObject({
  title: boundedText(MEMORY_EXTRACTOR_SKILL_HINT_TITLE_MAX, "title"),
  summary: boundedText(MEMORY_EXTRACTOR_SKILL_HINT_SUMMARY_MAX, "summary"),
});
export type MemorySkillHint = z.infer<typeof memorySkillHintSchema>;

/** The extractor's whole reply. Empty arrays are a valid "nothing to learn". */
export const memoryExtractorOutputSchema = z.strictObject({
  candidates: z.array(memoryExtractorCandidateSchema).max(MEMORY_EXTRACTOR_MAX_CANDIDATES),
  skill_hints: z.array(memorySkillHintSchema).max(MEMORY_EXTRACTOR_SKILL_HINTS_MAX),
});
export type MemoryExtractorOutput = z.infer<typeof memoryExtractorOutputSchema>;

const nullableUuid = { type: ["string", "null"] } as const;

/**
 * The JSON schema handed to a structured-output mode (`SERVER_CALL_RESPONSE_FORMATS.memory_learn`):
 * the same shape as {@link memoryExtractorOutputSchema}, in the strict-mode subset (every property
 * required, no extra keys, nullable by type). Cross-field rules (target per operation, inferred
 * only personal) are enforced by the zod schema when the server parses the reply.
 */
export const MEMORY_EXTRACTOR_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "skill_hints"],
  properties: {
    candidates: {
      type: "array",
      maxItems: MEMORY_EXTRACTOR_MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "statement",
          "kind",
          "suggested_scope",
          "portable",
          "project_specific",
          "source",
          "operation",
          "target_id",
          "confidence",
          "rationale",
          "evidence",
        ],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: SEMANTIC_MEMORY_STATEMENT_MAX },
          kind: { type: "string", enum: SEMANTIC_MEMORY_KINDS },
          suggested_scope: { type: "string", enum: MEMORY_CANDIDATE_SCOPES },
          portable: { type: "boolean" },
          project_specific: { type: "boolean" },
          source: { type: "string", enum: MEMORY_CANDIDATE_SOURCES },
          operation: { type: "string", enum: MEMORY_CANDIDATE_OPERATIONS },
          target_id: nullableUuid,
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string", minLength: 1, maxLength: MEMORY_EXTRACTOR_RATIONALE_MAX },
          evidence: {
            type: "array",
            minItems: MEMORY_EXTRACTOR_EVIDENCE_MIN,
            maxItems: MEMORY_EXTRACTOR_EVIDENCE_MAX,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["entry_id", "quote"],
              properties: {
                entry_id: { type: "string", minLength: 1, maxLength: 128 },
                quote: { type: "string", minLength: 1, maxLength: MEMORY_EXTRACTOR_QUOTE_MAX },
              },
            },
          },
        },
      },
    },
    skill_hints: {
      type: "array",
      maxItems: MEMORY_EXTRACTOR_SKILL_HINTS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: MEMORY_EXTRACTOR_SKILL_HINT_TITLE_MAX },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: MEMORY_EXTRACTOR_SKILL_HINT_SUMMARY_MAX,
          },
        },
      },
    },
  },
} as const;

export type MemoryExtractorOutcome =
  | { readonly ok: true; readonly output: MemoryExtractorOutput }
  | { readonly ok: false; readonly reason: "schema_rejected" };

const FENCED = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/;

/**
 * Parse the extractor's reply: the JSON alone or as exactly one fenced code block. Anything else,
 * or JSON that fails {@link memoryExtractorOutputSchema}, is `schema_rejected` (retried once).
 */
export function parseMemoryExtractorOutput(reply: string): MemoryExtractorOutcome {
  const trimmed = reply.trim();
  const body = FENCED.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: "schema_rejected" };
  }
  const parsed = memoryExtractorOutputSchema.safeParse(value);
  return parsed.success
    ? { ok: true, output: parsed.data }
    : { ok: false, reason: "schema_rejected" };
}

// ----------------------------------------------------------------------------- pass events

/**
 * Pass events (events.ts) on the thread's stream: written to the run the pass's server-call token
 * is bound to (the leaf's last completed run), after that run's terminal event. They are not an
 * epilogue: never announced in `run.completed.epilogue`. The server's append guard admits them for
 * a run with an open pass (one `completed` or `failed` per pass, after which the pass is closed),
 * within `MEMORY_PASS_MAX_MS` (server-call.ts) of the pass's start.
 */
export const MEMORY_PASS_EVENT_TYPES = [
  "memory.pass.progress",
  "memory.pass.completed",
  "memory.pass.failed",
] as const;
export type MemoryPassEventType = (typeof MEMORY_PASS_EVENT_TYPES)[number];

/** Where a running pass is (`memory.pass.progress.stage`). */
export const MEMORY_PASS_STAGES = ["reading", "extracting", "checking"] as const;
export const memoryPassStageSchema = z.enum(MEMORY_PASS_STAGES);
export type MemoryPassStage = z.infer<typeof memoryPassStageSchema>;

/**
 * Why a pass failed (`memory.pass.failed.code`): the budget is used up (refused at 100 %), no
 * learning model is set or enabled for the Workspace (never a fallback), semantic memory is off,
 * the reply failed the schema after its retry, the call timed out, the provider failed, the
 * author cancelled it, or the thread stayed locked by another change while the result was being
 * saved (`thread_busy`, after a few tries; KOBE-770).
 */
export const MEMORY_PASS_FAILURE_CODES = [
  "budget_exhausted",
  "learning_model_unavailable",
  "memory_disabled",
  "schema_rejected",
  "timeout",
  "model_error",
  "cancelled",
  "thread_busy",
] as const;
export const memoryPassFailureCodeSchema = z.enum(MEMORY_PASS_FAILURE_CODES);
export type MemoryPassFailureCode = z.infer<typeof memoryPassFailureCodeSchema>;

const count = z.number().int().min(0);

export const memoryPassEventPayloadSchemas = {
  "memory.pass.progress": z.strictObject({
    pass_id: uuidSchema,
    thread_id: uuidSchema,
    stage: memoryPassStageSchema,
    /** Thread entries the pass reads (set from `reading` on). */
    entries: count.optional(),
  }),
  "memory.pass.completed": z.strictObject({
    pass_id: uuidSchema,
    thread_id: uuidSchema,
    /** Candidates stored for review (may be 0: nothing new to learn). */
    candidates: count.max(MEMORY_EXTRACTOR_MAX_CANDIDATES),
    /** Candidates the checks dropped (duplicates, dismissed before, secrets, invalid evidence). */
    dropped: count.max(MEMORY_EXTRACTOR_MAX_CANDIDATES),
    skill_hints: count.max(MEMORY_EXTRACTOR_SKILL_HINTS_MAX),
  }),
  "memory.pass.failed": z.strictObject({
    pass_id: uuidSchema,
    thread_id: uuidSchema,
    code: memoryPassFailureCodeSchema,
    message: z.string().min(1).max(1000),
    /** Whether "Try again" is offered (not for a disabled switch or a missing model). */
    retryable: z.boolean(),
  }),
} as const satisfies Record<MemoryPassEventType, z.ZodType>;
