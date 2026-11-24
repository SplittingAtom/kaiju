import { MEMORY_PASS_MAX_MS } from "@kobe/protocol";
import type { LearnState } from "./learn-api";

/**
 * Watching a learning pass this tab started (KOBE-395, KOBE-661): each read of the thread's Learn
 * state (`GET /v1/threads/{id}/learn`, served from Postgres by whichever replica answers) decides
 * whether the pass still runs, has ended (found something, nothing, or failed), or has run so long
 * that the + stops spinning and offers Try again. Pure, so the state machine is tested on its own.
 */

/** Past this the + gives up on a pass it watches: the server's own limit, plus some slack. */
export const LEARN_SPIN_MAX_MS = MEMORY_PASS_MAX_MS + 15_000;

export const LEARN_TIMEOUT_MESSAGE =
  "Kaiju couldn't confirm that learning from this chat finished. Try again.";

export interface LearnWatch {
  readonly passId: string;
  /** When this tab started watching (ms since the epoch). */
  readonly since: number;
}

export type LearnStep =
  /** Nothing watched: show the state as read. */
  | { readonly kind: "idle"; readonly state: LearnState }
  /** The watched pass still runs (or a later one: watch that one). */
  | { readonly kind: "running"; readonly state: LearnState; readonly watch: LearnWatch }
  | {
      readonly kind: "ended";
      readonly state: LearnState;
      readonly passId: string;
      /** The server's sentence when the pass failed; null when it completed. */
      readonly failure: string | null;
    }
  /** Watched too long: stop spinning, say Try again. */
  | { readonly kind: "timeout"; readonly state: LearnState; readonly passId: string };

const notRunning = (state: LearnState): LearnState => ({ ...state, running: null });

/**
 * The next step for a fresh read `next`, given the pass watched (if any), the passes given up on
 * (shown as not running, so the + does not spin again) and the time now.
 */
export function learnStep(
  watch: LearnWatch | null,
  next: LearnState,
  now: number,
  abandoned: ReadonlySet<string> = new Set(),
): LearnStep {
  const running = next.running;
  const shown = running !== null && abandoned.has(running.passId) ? notRunning(next) : next;
  if (watch === null) {
    if (shown.running === null) return { kind: "idle", state: shown };
    return {
      kind: "running",
      state: shown,
      watch: { passId: shown.running.passId, since: now },
    };
  }
  if (running === null || running.passId !== watch.passId) {
    const failure = next.lastFailure?.passId === watch.passId ? next.lastFailure.message : null;
    return { kind: "ended", state: shown, passId: watch.passId, failure };
  }
  if (now - watch.since > LEARN_SPIN_MAX_MS) {
    return { kind: "timeout", state: notRunning(next), passId: watch.passId };
  }
  return { kind: "running", state: next, watch };
}
