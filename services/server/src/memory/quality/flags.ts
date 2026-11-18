/**
 * Quality flags of one memory (KOBE-411, SM30), computed on read from its run records and the
 * answer ratings of those runs (KOBE-275). Review labels only: nothing archives, evicts or
 * deletes by them.
 *
 * - **check this**: more than {@link CHECK_THIS_DOWN_RATIO} of the runs that received it got a
 *   thumbs down, over at least {@link CHECK_THIS_MIN_RUNS} runs.
 * - **unused**: no run received it for the Site's `unused_after_days` (default 90); an item never
 *   received counts from when it was created. (Distinct from KOBE-386's `stale`: not changed.)
 */

export const CHECK_THIS_MIN_RUNS = 10;
export const CHECK_THIS_DOWN_RATIO = 0.3;
const DAY_MS = 86_400_000;

export interface ItemUse {
  readonly runs: number;
  /** Runs that received the item with at least one thumbs down. */
  readonly downRuns: number;
  readonly lastReceivedAt: Date | string | null;
  readonly createdAt: Date | string;
}

export interface QualityFlags {
  readonly check_this: boolean;
  readonly unused: boolean;
}

export function qualityFlags(
  use: ItemUse,
  unusedAfterDays: number,
  now = new Date(),
): QualityFlags {
  const cutoff = now.getTime() - unusedAfterDays * DAY_MS;
  const since = new Date(use.lastReceivedAt ?? use.createdAt).getTime();
  return {
    check_this: use.runs >= CHECK_THIS_MIN_RUNS && use.downRuns / use.runs > CHECK_THIS_DOWN_RATIO,
    unused: since < cutoff,
  };
}
