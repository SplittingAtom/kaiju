/**
 * Which part of the visible branch a learning pass reads (KOBE-392; SM15, Chris Q9), without the
 * database. The branch is root → `threads.leaf_entry_id`, root first.
 *
 * - **Lower bound.** A fork or a copy of a shared thread starts with the source's entries, copied
 *   with their ids, times and order up to `forked_at_entry_id` (threads/fork.ts). Learning starts
 *   at the fork/copy point: a copied entry is never read in the copy, whatever the watermark or a
 *   rescan says. An entry is copied when it is no newer than the fork's own row or its `seq` is no
 *   later than the fork entry's (both, like the export's H-1 rule, so a missing fork entry still
 *   holds the bound). Copied entries are always a prefix of any branch of the fork.
 * - **Watermark by entry.** The author's last learned entry on this thread: if it is on the branch
 *   the pass continues after it; otherwise (the author switched branches) it rescans from the
 *   lowest common ancestor of the watermark and the leaf (what both branches share was learned).
 *   `rescan` ignores the watermark.
 */

export interface PathEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly createdAt: Date;
}

export interface ForkBound {
  /** `seq` of `forked_at_entry_id` in this thread; null when that entry is missing. */
  readonly forkSeq: number | null;
  /** When the fork's thread row was created (copied entries keep the source's older times). */
  readonly threadCreatedAt: Date;
}

export interface WatermarkWalk {
  readonly entryId: string;
  /** The watermark entry and its ancestors, nearest first (the watermark itself first). */
  readonly ancestors: readonly string[];
}

export interface RangeInput {
  /** The visible branch, root first. */
  readonly path: readonly PathEntry[];
  /** Set for a fork or a shared-thread copy; null for an original thread. */
  readonly fork: ForkBound | null;
  readonly watermark: WatermarkWalk | null;
  readonly rescan: boolean;
}

/** `full`: no watermark; `continue`: after the watermark; `lca`: after the common ancestor. */
export type RangeMode = "full" | "continue" | "lca" | "rescan";

export interface LearningRange {
  /** Index of the first entry read; `path.length` = nothing new. */
  readonly start: number;
  readonly mode: RangeMode;
  /** Index of the first entry after the copied prefix (0 for an original thread). */
  readonly lowerBound: number;
}

function isCopied(e: PathEntry, fork: ForkBound): boolean {
  return (
    e.createdAt.getTime() <= fork.threadCreatedAt.getTime() ||
    (fork.forkSeq !== null && e.seq <= fork.forkSeq)
  );
}

function lowerBoundOf(path: readonly PathEntry[], fork: ForkBound | null): number {
  if (fork === null) return 0;
  let bound = 0;
  path.forEach((e, i) => {
    if (isCopied(e, fork)) bound = i + 1;
  });
  return bound;
}

export function learningRange(input: RangeInput): LearningRange {
  const lowerBound = lowerBoundOf(input.path, input.fork);
  const from = (start: number, mode: RangeMode): LearningRange => ({
    start: Math.max(lowerBound, start),
    mode,
    lowerBound,
  });
  if (input.rescan) return from(0, "rescan");
  if (input.watermark === null) return from(0, "full");
  const index = new Map(input.path.map((e, i) => [e.entryId, i]));
  const at = index.get(input.watermark.entryId);
  if (at !== undefined) return from(at + 1, "continue");
  for (const id of input.watermark.ancestors) {
    const common = index.get(id);
    if (common !== undefined) return from(common + 1, "lca");
  }
  return from(0, "lca");
}

/**
 * Whether a compaction summary folds in entries from before the fork/copy point (Q9). Pi folds the
 * branch before `firstKeptEntryId` into the summary (from the root), so in a fork with a copied
 * prefix any summary that folds in something reaches it. Such a summary is dropped: even though a
 * summary is never evidence, pre-fork content could steer inferred candidates. An unknown or
 * off-branch first kept entry counts as folding in everything.
 */
export function summaryReachesBeforeFork(
  firstKeptEntryId: string | null,
  pathIndex: ReadonlyMap<string, number>,
  lowerBound: number,
): boolean {
  if (lowerBound === 0) return false;
  const kept = firstKeptEntryId === null ? undefined : pathIndex.get(firstKeptEntryId);
  return kept === undefined || kept > 0;
}
