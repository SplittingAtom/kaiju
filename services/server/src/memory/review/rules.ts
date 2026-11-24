import type { SemanticMemoryKind, SemanticMemoryScope } from "@kaiju/protocol";
import type { StoredCandidate } from "./stored.js";

/**
 * To review's rules for one candidate (KOBE-396, SM16), pure so the panel and the server agree:
 * which scopes the person may save it to, and what a click asks for. The server applies them
 * again at every click (`decide.ts`), with the item store's own checks after them.
 *
 * - An **inferred** candidate stays personal: `user` or `portable` only (spec: the agent has no
 *   write path; inferred candidates are user/portable only), and the picker is locked.
 * - A Workspace save needs the person's own words: a `stated` or `confirmed` candidate whose
 *   evidence quotes the person (checked against the thread at click, `evidence.ts`).
 * - A candidate that acts on an existing item (`update`, `supersede`, `conflict`) stays in that
 *   item's scope (locked).
 * - Portable memories are preferences.
 * - A project-specific Workspace candidate belongs in the project's Notes (Add to project notes,
 *   KOBE-398: `project-notes.ts`); Save keeps it as a personal memory.
 * - Never `site`: only a Team admin's confirmation moves a statement there (Phase C proposals).
 */

export type ReviewScope = Extract<SemanticMemoryScope, "user" | "portable" | "team">;

/** The scope a candidate would be saved to as the pass suggested it. */
export function suggestedScope(c: StoredCandidate): ReviewScope {
  if (c.destination === "portable") return "portable";
  if (c.destination === "team") return "team";
  return "user";
}

/** Scopes the person may pick for this candidate, the suggested one first. */
export function allowedScopes(
  c: StoredCandidate,
  kind: SemanticMemoryKind = c.kind,
): ReviewScope[] {
  if (c.target_id !== null) return [suggestedScope(c)];
  const personal: ReviewScope[] = kind === "preference" ? ["user", "portable"] : ["user"];
  if (c.source === "inferred" || c.destination === "project_notes") return personal;
  const all: ReviewScope[] = [...personal, "team"];
  const first = suggestedScope(c);
  return all.includes(first) ? [first, ...all.filter((s) => s !== first)] : all;
}

/** Whether the scope picker is locked (one scope, or an inferred candidate). */
export function scopeLocked(c: StoredCandidate): boolean {
  return c.source === "inferred" || c.target_id !== null;
}

/** "You said" / "You confirmed" / "Kaiju noticed" (the card's source label). */
export const SOURCE_LABELS = {
  stated: "You said",
  confirmed: "You confirmed",
  inferred: "Kaiju noticed",
} as const;

/** What a save of this candidate does to memory. */
export type SaveShape =
  | { readonly op: "create" }
  | { readonly op: "update"; readonly targetId: string }
  | { readonly op: "supersede"; readonly targetId: string };

/**
 * `add` creates; `update` adds a version to its target; `supersede` and `conflict` save a new
 * item that replaces the target (for a conflict, the reviewer chose the new statement by saving).
 */
export function saveShape(c: StoredCandidate): SaveShape {
  if (c.target_id === null || c.operation === "add") return { op: "create" };
  if (c.operation === "update") return { op: "update", targetId: c.target_id };
  return { op: "supersede", targetId: c.target_id };
}

/** Only new personal memories are in **Save all mine** (one batch, one Undo). */
export function inSaveAllMine(c: StoredCandidate): boolean {
  if (c.operation !== "add" || c.destination === "project_notes") return false;
  const scope = suggestedScope(c);
  return scope === "user" || (scope === "portable" && c.kind === "preference");
}
