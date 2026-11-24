import type { KaijuTx } from "@kaiju/db";
import { DEFAULT_CAPS, entryCost, type BudgetCaps } from "./budget.js";
import { readEntries, type PathRow } from "./read.js";
import { toTranscriptPiece, type SkipReason, type TranscriptPiece } from "./transcript.js";

/**
 * Reads the bodies of a branch range newest first, a chunk at a time, and stops once the turns
 * read are over the cap (budget.ts keeps the newest of them): a first pass over a long thread
 * never loads every body. When it stops early, the newest compaction entry of the part not read
 * is read too, so the over-cap fallback still has its summary. A summary that folds in pre-fork
 * content is left out (`pre_fork_summary`), and an offloaded message counts as `offloaded` (it is
 * read as a placeholder).
 */

/** Entry bodies per query. */
export const READ_CHUNK = 200;

export interface Collected {
  /** In branch order (oldest first); skipped entries included, as `skip` pieces. */
  readonly pieces: readonly TranscriptPiece[];
  /** Older entries of the range were never read (over the cap). */
  readonly stoppedEarly: boolean;
  readonly skipped: Readonly<Partial<Record<SkipReason, number>>>;
}

export async function collectPieces(
  tx: KaijuTx,
  where: { readonly teamId: string; readonly threadId: string },
  range: readonly PathRow[],
  options: {
    readonly includeToolOutputs: boolean;
    /** A compaction summary to leave out (one folding in pre-fork content: range.ts). */
    readonly dropSummary?: (firstKeptEntryId: string | null) => boolean;
  },
  caps: BudgetCaps = DEFAULT_CAPS,
): Promise<Collected> {
  const screen = (p: TranscriptPiece): TranscriptPiece =>
    p.kind === "compaction" && options.dropSummary?.(p.firstKeptEntryId)
      ? { kind: "skip", why: "pre_fork_summary" }
      : p;
  const read = async (rows: readonly PathRow[]): Promise<TranscriptPiece[]> => {
    const bodies = await readEntries(
      tx,
      where.teamId,
      where.threadId,
      rows.map((r) => r.entryId),
    );
    return rows.map((r) => {
      const body = bodies.get(r.entryId);
      return body
        ? screen(toTranscriptPiece(body, options))
        : ({ kind: "skip", why: "not_a_turn" } as const);
    });
  };
  let pieces: TranscriptPiece[] = [];
  let tokens = 0;
  let bytes = 0;
  let end = range.length;
  while (end > 0) {
    const start = Math.max(0, end - READ_CHUNK);
    const chunk = await read(range.slice(start, end));
    pieces = [...chunk, ...pieces];
    for (const p of chunk) {
      if (p.kind !== "turn") continue;
      const c = entryCost(p.entry);
      tokens += c.tokens;
      bytes += c.bytes;
    }
    end = start;
    if (tokens > caps.maxTokens || bytes > caps.maxBytes) break;
  }
  const stoppedEarly = end > 0;
  if (stoppedEarly && !pieces.some((p) => p.kind === "compaction")) {
    const older = range.slice(0, end);
    const newest = older.findLast((r) => r.type === "compaction");
    if (newest) pieces = [...(await read([newest])), ...pieces];
  }
  const skipped: Partial<Record<SkipReason, number>> = {};
  const count = (why: SkipReason) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const p of pieces) {
    if (p.kind === "skip") count(p.why);
    else if (p.kind === "turn" && p.entry.placeholder) count("offloaded");
  }
  return { pieces, stoppedEarly, skipped };
}
