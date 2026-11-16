import type { ExtractorTranscriptEntry } from "../prompt/input.js";
import type { TranscriptPiece } from "./transcript.js";

/**
 * Fits the pass's transcript under the input cap (KOBE-392, SM15), without the database. When the
 * whole range fits, every turn is read and compaction summaries are left out (the turns they
 * summarise are there). Over the cap, the pass reads the newest compaction summary of the range
 * and the newest turns that fit beside it, and is flagged (`truncated`) for the panel; without a
 * compaction it reads the newest turns alone. Summaries are written by a model, so they are never
 * a source of memories (the prompt's `summary` speaker); they only give the tail its context.
 */

/** About 60k tokens of transcript (SM15), estimated at four characters a token. */
export const LEARN_INPUT_MAX_TOKENS = 60_000;
/**
 * UTF-8 bytes of transcript text: well inside the `memory_learn` body cap (384 KiB) with the
 * system prompt, up to 125 listed items, JSON escaping and the response format beside it.
 */
export const LEARN_INPUT_MAX_BYTES = 256 * 1024;
export const CHARS_PER_TOKEN = 4;
/** One entry's header line in the prompt (`<<<entry nonce id=… speaker=…>>>`). */
export const ENTRY_OVERHEAD_TOKENS = 24;
export const ENTRY_OVERHEAD_BYTES = 96;

export interface BudgetCaps {
  readonly maxTokens: number;
  readonly maxBytes: number;
}

export const DEFAULT_CAPS: BudgetCaps = {
  maxTokens: LEARN_INPUT_MAX_TOKENS,
  maxBytes: LEARN_INPUT_MAX_BYTES,
};

export interface Cost {
  readonly tokens: number;
  readonly bytes: number;
}

export function entryCost(entry: ExtractorTranscriptEntry): Cost {
  return {
    tokens: Math.ceil(entry.text.length / CHARS_PER_TOKEN) + ENTRY_OVERHEAD_TOKENS,
    bytes: Buffer.byteLength(entry.text) + ENTRY_OVERHEAD_BYTES,
  };
}

export interface FittedTranscript {
  /** Oldest first. */
  readonly transcript: readonly ExtractorTranscriptEntry[];
  /** Over the cap: older turns were left out (the panel flags it). */
  readonly truncated: boolean;
  /** A compaction summary stands in for the turns left out. */
  readonly summarised: boolean;
  /** Turns left out. */
  readonly omitted: number;
  readonly estimatedTokens: number;
}

interface Placed {
  readonly at: number;
  readonly entry: ExtractorTranscriptEntry;
  readonly cost: Cost;
}

const sum = (items: readonly Placed[]): Cost =>
  items.reduce((a, p) => ({ tokens: a.tokens + p.cost.tokens, bytes: a.bytes + p.cost.bytes }), {
    tokens: 0,
    bytes: 0,
  });

const within = (c: Cost, caps: BudgetCaps) =>
  c.tokens <= caps.maxTokens && c.bytes <= caps.maxBytes;

/** The newest turns that fit `caps`, oldest first. */
function tailOf(turns: readonly Placed[], caps: BudgetCaps): Placed[] {
  const tail: Placed[] = [];
  let spent: Cost = { tokens: 0, bytes: 0 };
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as Placed;
    const next = { tokens: spent.tokens + t.cost.tokens, bytes: spent.bytes + t.cost.bytes };
    if (!within(next, caps)) break;
    tail.unshift(t);
    spent = next;
  }
  return tail;
}

export function fitTranscript(
  pieces: readonly TranscriptPiece[],
  caps: BudgetCaps = DEFAULT_CAPS,
): FittedTranscript {
  const place = (entry: ExtractorTranscriptEntry, at: number): Placed => ({
    at,
    entry,
    cost: entryCost(entry),
  });
  const turns: Placed[] = [];
  let summary: Placed | undefined;
  pieces.forEach((p, at) => {
    if (p.kind === "turn") turns.push(place(p.entry, at));
    else if (p.kind === "compaction") summary = place(p.entry, at);
  });
  const done = (kept: readonly Placed[], withSummary: Placed | undefined): FittedTranscript => {
    const all = withSummary ? [...kept, withSummary].sort((a, b) => a.at - b.at) : [...kept];
    return {
      transcript: all.map((p) => p.entry),
      truncated: kept.length < turns.length,
      summarised: withSummary !== undefined,
      omitted: turns.length - kept.length,
      estimatedTokens: sum(all).tokens,
    };
  };
  if (within(sum(turns), caps)) return done(turns, undefined);
  const tail = tailOf(turns, caps);
  if (summary === undefined) return done(tail, undefined);
  const s = summary;
  const beside = tailOf(tail, {
    maxTokens: caps.maxTokens - s.cost.tokens,
    maxBytes: caps.maxBytes - s.cost.bytes,
  });
  return beside.length === 0 ? done(tail, undefined) : done(beside, s);
}
