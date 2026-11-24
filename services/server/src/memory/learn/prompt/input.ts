import {
  SEMANTIC_MEMORY_STATEMENT_MAX,
  semanticMemoryKindSchema,
  semanticMemoryScopeSchema,
  uuidSchema,
} from "@kaiju/protocol";
import { z } from "zod";

/**
 * What the extractor prompt is built from (KOBE-394). KOBE-392 (pass input) fills it from the
 * thread up to the leaf and the Workspace's related items; KOBE-393 (pass execution) hands it to
 * {@link extractorMessages} and then to `screenExtractorOutput` (memory/learn/screen.ts).
 *
 * The transcript is the conversation as the learner sees it, oldest first. Each entry keeps the
 * thread entry's id (evidence quotes cite it) and says who produced the text:
 *
 * - `person`: the thread's author, the person teaching Kaiju. Only their words can support a
 *   candidate.
 * - `assistant`: the agent's replies. A person may confirm what it said; on its own it proves
 *   nothing.
 * - `tool`: tool calls' output (files, web pages, MCP results). Never a source of memories.
 * - `summary`: compaction and branch summaries (`branch_summary`): written by a model, so never a
 *   source either.
 *
 * Images, attachments and approvals are left out or described in text by KOBE-392.
 */
/**
 * Entry ids the prompt may carry in its entry headers (KOBE-392): Pi's short hex and the server's
 * `ks-`/`ku-`/`ka-` ids. Pi's ids come from the sandbox (untrusted), so the pass input skips any
 * other entry rather than risk header syntax in the prompt.
 */
const SAFE_ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeEntryId = (id: string): boolean => SAFE_ENTRY_ID.test(id);

export const EXTRACTOR_SPEAKERS = ["person", "assistant", "tool", "summary"] as const;
export const extractorSpeakerSchema = z.enum(EXTRACTOR_SPEAKERS);
export type ExtractorSpeaker = z.infer<typeof extractorSpeakerSchema>;

export const extractorTranscriptEntrySchema = z.strictObject({
  /**
   * The thread entry's id: Pi's short hex or the server's `ks-`/`ku-`/`ka-` ids (KOBE-392). Letters,
   * digits, `-` and `_` only, so it cannot carry header syntax into the prompt.
   */
  entry_id: z.string().refine(isSafeEntryId, { message: "entry id has unsafe characters" }),
  speaker: extractorSpeakerSchema,
  text: z.string().min(1),
  /**
   * A stand-in for a body the pass could not read (offloaded, KOBE-392): shown so the model knows
   * something was there, never quotable as evidence (`screen.ts` leaves it out).
   */
  placeholder: z.literal(true).optional(),
});
export type ExtractorTranscriptEntry = z.infer<typeof extractorTranscriptEntrySchema>;

/**
 * An existing item the person can see that may relate to the conversation (KOBE-392 picks them):
 * the extractor avoids restating it and may `update`, `supersede` or `conflict` it. Policy items
 * (`policy: true`) are listed first and are never a candidate's target.
 */
export const extractorExistingItemSchema = z.strictObject({
  id: uuidSchema,
  scope: semanticMemoryScopeSchema,
  kind: semanticMemoryKindSchema,
  policy: z.boolean(),
  statement: z.string().min(1).max(SEMANTIC_MEMORY_STATEMENT_MAX),
  /**
   * The item's current version when listed (KOBE-779): kept on a candidate that acts on it, so
   * To review refuses an update once the item moved on. Never shown to the model.
   */
  version: z.number().int().positive().optional(),
});
export type ExtractorExistingItem = z.infer<typeof extractorExistingItemSchema>;

const unique = (keys: readonly string[]): boolean => new Set(keys).size === keys.length;

export const extractorPromptInputSchema = z.strictObject({
  /** The thread's project (its name), or null when the thread is in no project. */
  project: z.strictObject({ name: z.string().min(1).max(200) }).nullable(),
  existing: z
    .array(extractorExistingItemSchema)
    .refine((items) => unique(items.map((i) => i.id)), { message: "existing item ids are unique" }),
  transcript: z
    .array(extractorTranscriptEntrySchema)
    .min(1)
    .refine((entries) => unique(entries.map((e) => e.entry_id)), {
      message: "transcript entry ids are unique",
    }),
});
export type ExtractorPromptInput = z.infer<typeof extractorPromptInputSchema>;
