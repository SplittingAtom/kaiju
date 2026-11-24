import type { Candidate, ReviewScope } from "../../../lib/memory/review-api";

/** The card's words (KOBE-396): UI says Workspace; the wire scope is `team`. */
export const SCOPE_LABELS: Readonly<Record<ReviewScope, string>> = {
  user: "Just me (this workspace)",
  portable: "Me, in all my workspaces",
  team: "This Workspace",
};

export const SOURCE_LABELS: Readonly<Record<Candidate["source"], string>> = {
  stated: "You said",
  confirmed: "You confirmed",
  inferred: "Kaiju noticed",
};

export const OPERATION_LABELS: Readonly<Record<Candidate["operation"], string>> = {
  add: "New memory",
  update: "Updates a memory",
  supersede: "Replaces a memory",
  conflict: "Contradicts a memory",
};

/** "High (90%)": the extractor's confidence, in words and a number. */
export function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const word = confidence >= 0.8 ? "High" : confidence >= 0.6 ? "Medium" : "Low";
  return `${word} confidence (${pct}%)`;
}

/**
 * Project candidates (KOBE-398): the one line that tells a signed Notes approval from a project
 * file's Accept.
 */
export const PROJECT_LINE =
  "This is about the project: Add to project notes asks for a signed approval of the Notes change; " +
  "a project file's Accept changes only that file.";

/** Days left before an open candidate expires (14 days after its pass). */
export function daysLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 86_400_000));
}
