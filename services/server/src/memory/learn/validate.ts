import { createHash } from "node:crypto";
import { normaliseQuote } from "../quote-normalise.js";
import type { ScreenedCandidate } from "./screen.js";

/**
 * The pass's selection of screened candidates (KOBE-393, SM15, SM16), after `screen.ts` and before
 * the database checks (`candidates.ts`). Pure, so recorded replies replay through it in CI.
 *
 * A screened candidate is dropped, with the first reason that applies, when:
 *
 * - `inferred_shared`: it is inferred but would go to the Workspace or a project's Notes (the
 *   schema refuses it already; kept here so no later change can let one through);
 * - `low_confidence`: its confidence is under {@link LEARN_MIN_CONFIDENCE};
 * - `already_open`: the person already has the same statement open in To review;
 * - `dismissed`: the person dismissed the same statement in this thread before;
 * - `duplicate_in_reply`: the reply repeats a statement (the more confident copy stays);
 * - `over_limit`: more than {@link LEARN_MAX_CANDIDATES} are left (most confident first).
 *
 * "The same statement" is {@link statementHash}: the shared quote normaliser, then lower case.
 */

/** Candidates under this confidence are dropped. */
export const LEARN_MIN_CONFIDENCE = 0.4;
/** Most candidates one pass stores for review. */
export const LEARN_MAX_CANDIDATES = 10;

export const SELECT_DROP_REASONS = [
  "inferred_shared",
  "low_confidence",
  "already_open",
  "dismissed",
  "duplicate_in_reply",
  "over_limit",
] as const;
export type SelectDropReason = (typeof SELECT_DROP_REASONS)[number];

/** Lowercase hex SHA-256 of the normalised, lower-cased statement (`memory_dismissals`). */
export function statementHash(statement: string): string {
  return createHash("sha256").update(normaliseQuote(statement).toLowerCase(), "utf8").digest("hex");
}

export interface SelectedCandidate extends ScreenedCandidate {
  readonly hash: string;
}

export interface KnownStatements {
  /** Hashes of the person's open candidates in this Workspace. */
  readonly open: ReadonlySet<string>;
  /** Hashes the person dismissed in this thread. */
  readonly dismissed: ReadonlySet<string>;
}

export interface SelectResult {
  /** Most confident first, at most {@link LEARN_MAX_CANDIDATES}. */
  readonly selected: readonly SelectedCandidate[];
  readonly dropped: readonly { readonly statement: string; readonly reason: SelectDropReason }[];
}

function ruleReason(c: SelectedCandidate, known: KnownStatements): SelectDropReason | null {
  if (c.candidate.source === "inferred" && c.destination !== "user" && c.destination !== "portable")
    return "inferred_shared";
  if (c.candidate.confidence < LEARN_MIN_CONFIDENCE) return "low_confidence";
  if (known.open.has(c.hash)) return "already_open";
  if (known.dismissed.has(c.hash)) return "dismissed";
  return null;
}

export function selectCandidates(
  kept: readonly ScreenedCandidate[],
  known: KnownStatements,
): SelectResult {
  const dropped: { statement: string; reason: SelectDropReason }[] = [];
  const drop = (c: SelectedCandidate, reason: SelectDropReason) =>
    dropped.push({ statement: c.candidate.statement, reason });
  const passing: SelectedCandidate[] = [];
  for (const s of kept) {
    const c = { ...s, hash: statementHash(s.candidate.statement) };
    const reason = ruleReason(c, known);
    if (reason) drop(c, reason);
    else passing.push(c);
  }
  // Stable: equal confidence keeps the reply's order.
  const ranked = [...passing].sort((a, b) => b.candidate.confidence - a.candidate.confidence);
  const seen = new Set<string>();
  const selected: SelectedCandidate[] = [];
  for (const c of ranked) {
    if (seen.has(c.hash)) drop(c, "duplicate_in_reply");
    else if (selected.length >= LEARN_MAX_CANDIDATES) drop(c, "over_limit");
    else {
      seen.add(c.hash);
      selected.push(c);
    }
  }
  return { selected, dropped };
}
