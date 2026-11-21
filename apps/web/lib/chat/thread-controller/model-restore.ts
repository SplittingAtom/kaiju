/**
 * Regenerate with another model (CE17, KOBE-217): which model to put back when the message does
 * not go, and which failure stays shown (pure planners, KOBE-716).
 */
import type { ApiError } from "../../api/client";
import { canRegenerateWith, type ThreadState } from "../thread-state";

export const REGENERATE_NOT_SENT: ApiError = {
  status: 0,
  code: "regenerate_not_sent",
  message: "The answer could not be regenerated, so the model was not changed. Try again.",
};

export interface RegeneratePlan {
  /** The thread's model before the change (null: the team default). */
  readonly previous: string | null;
  /** The model changes first (and is put back if the message does not go). */
  readonly switching: boolean;
}

/** Undefined when regenerating is refused now (another choice is on its way). */
export function planRegenerate(s: ThreadState, model: string | null): RegeneratePlan | undefined {
  if (!canRegenerateWith(s)) return undefined;
  const previous = s.summary?.model ?? null;
  return { previous, switching: model !== previous };
}

/** The failure kept in the banner once the previous model is back. */
export function restoreFailure(s: ThreadState): NonNullable<ThreadState["actionError"]> {
  return s.actionError ?? { error: REGENERATE_NOT_SENT };
}
