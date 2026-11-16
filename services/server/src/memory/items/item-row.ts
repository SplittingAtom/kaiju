import type { SemanticMemoryActorKind, SemanticMemoryKind } from "@kobe/protocol";
import type { SelectLane } from "./select.js";

/** One row of a lane read (run-memory.ts), and of the vector leg (vector-leg.ts, KOBE-409). */
export interface ItemRow extends Record<string, unknown> {
  readonly lane: SelectLane | "policy";
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly pinned: boolean;
  readonly version: number;
  readonly statement: string;
  readonly actor_kind: SemanticMemoryActorKind;
  readonly as_of: string | null;
  readonly saved_on: string;
  readonly matched: boolean;
  readonly rank: number | string;
  readonly age_days: number | string;
  readonly sticky: boolean;
  readonly total: number | string;
  /** Cosine similarity with the query vector (vector leg only; KOBE-409). */
  readonly sim?: number | string;
}
