import type { LearnMode, LearnRefusalCode } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";

/**
 * Learn from this chat (KOBE-395): the thread's Learn state for the composer's + button and the
 * start of a pass (`/v1/threads/{id}/learn`). The protocol's `learnStateSchema`, camelized as the
 * API client reads every answer.
 */
export interface LearnState {
  readonly threadId: string;
  readonly blocker: {
    readonly code: LearnRefusalCode;
    readonly reason?: string | undefined;
    readonly message: string;
  } | null;
  readonly running: { readonly passId: string; readonly startedAt: string } | null;
  readonly newMessages: boolean;
  readonly candidates: number;
  readonly passesLeft: number;
  readonly lastFailure: {
    readonly passId: string;
    readonly message: string;
    readonly finishedAt: string;
  } | null;
  readonly estimate: { readonly newTokens: number | null; readonly allTokens: number } | null;
}

export interface LearnStarted {
  readonly passId: string;
  readonly runId: string;
  readonly modelAlias: string;
  readonly mode: LearnMode;
  readonly input: {
    readonly entries: number;
    readonly truncated: boolean;
    readonly summarised: boolean;
    readonly partial: boolean;
    readonly estimatedTokens: number;
  };
}
const enc = encodeURIComponent;

export function getLearnState(
  teamId: string,
  threadId: string,
  options: { readonly estimate?: boolean } = {},
): Promise<ApiResult<LearnState>> {
  const q = options.estimate === true ? "?estimate=1" : "";
  return apiRequest(`/v1/threads/${enc(threadId)}/learn${q}`, { teamId });
}

export function startLearn(
  teamId: string,
  threadId: string,
  mode: LearnMode,
): Promise<ApiResult<LearnStarted>> {
  return apiRequest(`/v1/threads/${enc(threadId)}/learn`, {
    method: "POST",
    json: { mode },
    teamId,
  });
}

/** Where the person reviews candidates (KOBE-396's To review tab of My memory). */
export const TO_REVIEW_HREF = "/me/memory?tab=review";

/** From this many estimated tokens a `/learn` delta counts as long: its menu item shows the number. */
export const LONG_DELTA_TOKENS = 8_000;

/** `12345` → `~12k tokens`, `900` → `~900 tokens`. */
export function tokensLabel(tokens: number): string {
  if (tokens < 1_000) return `~${tokens} tokens`;
  const k = tokens / 1_000;
  return `~${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k tokens`;
}

/** What the + button shows: a pass running, candidates waiting, new messages, or nothing. */
export type LearnIndicator =
  | { readonly kind: "running" }
  | { readonly kind: "candidates"; readonly count: number }
  | { readonly kind: "new" }
  | { readonly kind: "none" };

export function learnIndicator(state: LearnState | null): LearnIndicator {
  if (state === null) return { kind: "none" };
  if (state.running !== null) return { kind: "running" };
  if (state.candidates > 0) return { kind: "candidates", count: state.candidates };
  if (state.newMessages && state.blocker === null) return { kind: "new" };
  return { kind: "none" };
}

/** Why `/learn` (new messages only) can't run, beyond the state's blocker. */
export function learnBlocker(state: LearnState | null, mode: LearnMode): string | null {
  if (state === null) return "Checking whether Kobe can learn from this chat…";
  if (state.blocker !== null) return state.blocker.message;
  if (state.running !== null) return "Kobe is already learning from this chat.";
  if (mode === "new" && !state.newMessages)
    return "Nothing new since the last pass. Rescan the whole chat instead.";
  return null;
}
