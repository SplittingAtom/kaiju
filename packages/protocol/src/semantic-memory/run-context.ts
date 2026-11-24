import { z } from "zod";
import { utf8ByteLength, uuidSchema } from "../common.js";
import {
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
  semanticMemoryActorKindSchema,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryScopeSchema,
  semanticMemoryStatementSchema,
} from "./fields.js";

/**
 * `run.start.memory.semantic` (KOBE-377; spec SM23, SM24): the semantic memory items the server
 * picked for this run, which kaiju-sandbox-agent renders as the "What Kaiju knows" block (KOBE-383)
 * above Notes. Additive: absent on an old server, for an agent without
 * {@link CAPABILITY_SEMANTIC_MEMORY}, for an agent version whose memory setting is `notes_only`
 * or `off` (KOBE-646), and for evals and test chats. The server records each item version given
 * in `run_memory_items` / `run_portable_memory_items` / `run_site_memory_items`.
 *
 * Order is stable-first (Chris 2026-11-12, Q6), so the cacheable prefix changes least: every
 * Policy item (always included, never pinned), then pinned items, then the per-message picks (re-picked on every message, SM24).
 * The selector (KOBE-382) decides membership; the schema checks the order and the byte budgets.
 */

/**
 * `hello.capabilities` entry of an agent that renders `run.start.memory.semantic`. It implies
 * `memory`: `semantic` travels only inside `run.start.memory`, which the server sends only to
 * agents listing `memory`, so an agent listing `semantic_memory` alone gets nothing (L11).
 */
export const CAPABILITY_SEMANTIC_MEMORY = "semantic_memory";

/**
 * Where the per-message picks reach the model (KOBE-658, Site setting `memory.placement`; Gate A
 * cache regression). Policy and pinned items stay in the system prompt in every mode.
 * - `system`: the picks in the system prompt (KOBE-383 as built).
 * - `latest_user_keep`: the picks beside the newest user message; earlier messages keep theirs.
 * - `latest_user_strip`: as keep, but only the newest message carries its picks.
 * - `stable_plus_delta`: a held pick set in the system prompt (items marked `held`, re-picked
 *   every N messages), the other picks beside the newest message.
 * - `tool_only`: no picks; the agent uses `recall` / `show_memory_item` (KOBE-399).
 * Absent = `system` (an old server). Sent only to agents listing
 * {@link CAPABILITY_SEMANTIC_MEMORY_PLACEMENT}.
 */
export const SEMANTIC_MEMORY_PLACEMENTS = [
  "system",
  "latest_user_keep",
  "latest_user_strip",
  "stable_plus_delta",
  "tool_only",
] as const;
export const semanticMemoryPlacementSchema = z.enum(SEMANTIC_MEMORY_PLACEMENTS);
export type SemanticMemoryPlacement = z.infer<typeof semanticMemoryPlacementSchema>;
export const SEMANTIC_MEMORY_PLACEMENT_DEFAULT: SemanticMemoryPlacement = "latest_user_keep";

/** `hello.capabilities` entry of an agent that renders `run.start.memory.semantic.placement`. */
export const CAPABILITY_SEMANTIC_MEMORY_PLACEMENT = "semantic_memory_placement";

/**
 * Bytes of the rendered "What Kaiju knows" block (SM23): block header and footer, each lane's
 * nonce fences and header, and each item's line (bullet, kind, provenance) plus its statement.
 * {@link semanticMemoryRenderedBytes} computes it with the fixed overheads below. The Site's
 * context budget (KOBE-381, Site setting `context_budget_kib`) picks the size from
 * {@link SEMANTIC_MEMORY_BLOCK_MIN_BYTES} to {@link SEMANTIC_MEMORY_BLOCK_MAX_BYTES}, default
 * {@link SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES}; the selector (KOBE-382) fills to that setting and
 * the renderer (KOBE-383) must stay within those overheads, so `omitted_count` stays true. The
 * schema enforces the range's top: a `run.start` never carries more than the largest budget. The
 * Policy cap ({@link SEMANTIC_MEMORY_POLICY_MAX_BYTES}) is a store limit over statement bytes.
 */
export const SEMANTIC_MEMORY_BLOCK_MIN_BYTES = 4 * 1024;
export const SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES = 8 * 1024;
export const SEMANTIC_MEMORY_BLOCK_MAX_BYTES = 16 * 1024;
/**
 * The headers ("What Kaiju knows", "… for this message" and, with `stable_plus_delta`, "… for this
 * conversation"), the preamble with the untrusted-data notice (longer when the picks travel beside
 * the person's message, KOBE-658), and the "n more not shown" line (KOBE-383: measured from the
 * sandbox's renderer, which tests that it stays within each overhead; 640 before KOBE-658).
 */
export const SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES = 768;
/**
 * One fence: its label line and nonce markers, open and close. A lane gets one fence among the
 * stable items (Policy, pinned) and another among the per-message picks when it has both
 * ({@link semanticMemoryRunFence}).
 */
export const SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES = 160;
/** One item: bullet, kind, provenance line and separators, besides the statement. */
export const SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES = 96;
/** Most items in one block. */
export const SEMANTIC_MEMORY_RUN_MAX_ITEMS = 100;

/**
 * Where a statement came from, for the model's provenance line: who wrote the version
 * (`actor_kind`), the item's `as_of` date, and the day the version was saved. Never thread
 * links, evidence or authors' names.
 */
export const runSemanticMemoryProvenanceSchema = z.strictObject({
  actor_kind: semanticMemoryActorKindSchema,
  as_of: semanticMemoryDateSchema.nullable(),
  saved_on: semanticMemoryDateSchema,
});

export const runSemanticMemoryItemSchema = z.strictObject({
  id: uuidSchema,
  version: z.number().int().positive(),
  scope: semanticMemoryScopeSchema,
  kind: semanticMemoryKindSchema,
  statement: semanticMemoryStatementSchema,
  policy: z.boolean(),
  pinned: z.boolean(),
  provenance: runSemanticMemoryProvenanceSchema,
  /** A pick of the held set (`stable_plus_delta`, KOBE-658): rendered in the system prompt. */
  held: z.literal(true).optional(),
});
export type RunSemanticMemoryItem = z.infer<typeof runSemanticMemoryItemSchema>;

/** 0 = Policy, 1 = pinned, 2 = a per-message pick. */
export const semanticMemoryRunRank = (item: { policy: boolean; pinned: boolean }): number =>
  item.policy ? 0 : item.pinned ? 1 : 2;

const bytes = (items: readonly RunSemanticMemoryItem[]) =>
  items.reduce((sum, i) => sum + utf8ByteLength(i.statement), 0);

/** The lane an item renders in: Policy, or its scope. */
export const semanticMemoryRunLane = (item: RunSemanticMemoryItem): string =>
  item.policy ? "policy" : item.scope;

/**
 * The fence an item renders in (KOBE-383): its lane, in the stable part (Policy, pinned) or among
 * the per-message picks. The server's selector and this estimate charge one fence overhead per
 * distinct value, so they count what the renderer draws.
 */
export const semanticMemoryRunFence = (item: {
  policy: boolean;
  pinned: boolean;
  scope: string;
  held?: boolean | undefined;
}) =>
  `${item.policy ? "policy" : item.scope}:${
    item.policy || item.pinned ? "stable" : item.held === true ? "held" : "pick"
  }`;

/**
 * Bytes of the rendered block for these items (see {@link SEMANTIC_MEMORY_BLOCK_MAX_BYTES}): an
 * upper bound of what the sandbox renders for statements as sent (it never lets a statement grow
 * past its byte length when sanitising, so the bound holds).
 */
export function semanticMemoryRenderedBytes(semantic: {
  items: readonly RunSemanticMemoryItem[];
  omitted_count?: number;
}): number {
  const lanes = new Set(semantic.items.map(semanticMemoryRunFence)).size;
  return (
    SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES +
    lanes * SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES +
    semantic.items.length * SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES +
    bytes(semantic.items)
  );
}

export const runSemanticMemorySchema = z
  .strictObject({
    items: z.array(runSemanticMemoryItemSchema).max(SEMANTIC_MEMORY_RUN_MAX_ITEMS),
    /** Eligible items left out to stay within the budgets (the agent may say there are more). */
    omitted_count: z.number().int().nonnegative(),
    /** Where the picks render (KOBE-658); absent = `system`. */
    placement: semanticMemoryPlacementSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["items"], message });
    v.items.forEach((item, i) => {
      if (item.policy && item.scope !== "site") issue(`item ${i}: Policy exists only on the Site`);
      if (item.policy && item.pinned) issue(`item ${i}: Policy items are never pinned`);
      if (item.scope === "portable" && item.kind !== "preference")
        issue(`item ${i}: portable items are preferences`);
      if (item.scope === "portable" && item.provenance.as_of !== null)
        issue(`item ${i}: portable items have no as_of`);
      const prev = v.items[i - 1];
      if (prev && semanticMemoryRunRank(prev) > semanticMemoryRunRank(item))
        issue(`item ${i}: order is Policy, pinned, then per-message picks`);
      if (item.held === true && (item.policy || item.pinned))
        issue(`item ${i}: only per-message picks are held`);
      if (item.held === true && v.placement !== "stable_plus_delta")
        issue(`item ${i}: held picks exist only with stable_plus_delta`);
      if (item.held === true && prev && semanticMemoryRunRank(prev) === 2 && prev.held !== true)
        issue(`item ${i}: held picks come before the other picks`);
      if (v.placement === "tool_only" && semanticMemoryRunRank(item) === 2)
        issue(`item ${i}: tool_only carries no per-message picks`);
    });
    if (new Set(v.items.map((i) => `${i.scope}:${i.id}`)).size !== v.items.length)
      issue("an item is listed twice");
    const policy = v.items.filter((i) => i.policy);
    if (policy.length > SEMANTIC_MEMORY_POLICY_MAX_ITEMS) issue("too many Policy items");
    if (bytes(policy) > SEMANTIC_MEMORY_POLICY_MAX_BYTES) issue("Policy exceeds its byte budget");
    if (semanticMemoryRenderedBytes(v) > SEMANTIC_MEMORY_BLOCK_MAX_BYTES)
      issue("rendered block exceeds its byte budget");
  });
export type RunSemanticMemory = z.infer<typeof runSemanticMemorySchema>;
