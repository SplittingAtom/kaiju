/**
 * Kernel completion for a `.py` file in the code editor (KOBE-808): asks the conversation's
 * running kernel, through `POST /v1/threads/{id}/notebook/complete`, for completions at the cursor
 * and for a name's signature and docstring. The editor's own (built-in) completion always works;
 * this only adds to it, and never holds typing up: every request is cancelled by the next
 * keystroke (`signal`), gives up after {@link KERNEL_COMPLETION_TIMEOUT_MS}, and while the kernel
 * can't answer (not started, sandbox asleep, code running, an older sandbox agent, too many
 * requests) no request is sent for a while and {@link KernelCompleter.state} says why, for the
 * editor's small indicator. The server never wakes a sandbox or starts a kernel for it.
 */
import { NOTEBOOK_COMPLETE_CODE_MAX_BYTES, isWellFormedText } from "@kobe/protocol";
import type { KernelCompletionAnswer, NotebookApi } from "./api";

/** Why kernel completion is (not) adding to the editor's own completion right now. */
export type KernelCompletionState =
  | "idle"
  | "ready"
  | "no_thread"
  | "no_kernel"
  | "asleep"
  | "busy"
  | "unsupported"
  | "unavailable"
  | "rate_limited";

/** The editor waits this long for an answer before it gives up on it. */
export const KERNEL_COMPLETION_TIMEOUT_MS = 2_000;
/** How long no request is sent after an answer that says the kernel can't help. */
export const KERNEL_BACKOFF_MS: Readonly<Partial<Record<KernelCompletionState, number>>> = {
  no_kernel: 5_000,
  asleep: 10_000,
  busy: 1_500,
  unavailable: 3_000,
  rate_limited: 20_000,
};
/** At most this much code before the cursor (and after it, on its line) is sent. */
export const WINDOW_BEFORE = 6_000;
export const WINDOW_AFTER = 1_000;

export interface KernelMatch {
  readonly label: string;
  readonly type?: string | undefined;
}

/** Matches replace the text between `from` and `to` (UTF-16 offsets into the code given). */
export interface KernelMatches {
  readonly from: number;
  readonly to: number;
  readonly matches: readonly KernelMatch[];
}

export interface KernelDoc {
  readonly signature?: string | undefined;
  readonly doc?: string | undefined;
  readonly type?: string | undefined;
}

export const KERNEL_STATE_TEXT: Readonly<Record<KernelCompletionState, string>> = {
  idle: "Kernel completion: on while the kernel runs",
  ready: "Kernel completion on",
  no_thread: "Kernel completion off: send a message first",
  no_kernel: "Kernel completion off: the kernel is not started",
  asleep: "Kernel completion off: your sandbox is asleep",
  busy: "Kernel completion paused: code is running",
  unsupported: "Kernel completion off: not available in your sandbox yet",
  unavailable: "Kernel completion off: the kernel did not answer",
  rate_limited: "Kernel completion paused: too many requests",
};

/** Code points in `s`, as Jupyter counts the cursor. */
export function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** The UTF-16 offset of code point `cp` in `s` (clamped to its length). */
export function utf16Offset(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length;
    i += pair && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff ? 2 : 1;
  }
  return i;
}

/** A dotted Python name the server accepts for `op: "doc"`. */
export const DOC_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/;

const utf8 = new TextEncoder();

export class KernelCompleter {
  readonly #api: Pick<NotebookApi, "complete">;
  readonly #threadId: string | null;
  readonly #now: () => number;
  #state: KernelCompletionState;
  #pausedUntil = 0;
  #running = false;
  #inflight: AbortController | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    api: Pick<NotebookApi, "complete">,
    threadId: string | null,
    now: () => number = Date.now,
  ) {
    this.#api = api;
    this.#threadId = threadId;
    this.#now = now;
    this.#state = threadId === null ? "no_thread" : "idle";
  }

  get state(): KernelCompletionState {
    return this.#running && this.#state !== "unsupported" && this.#threadId !== null
      ? "busy"
      : this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): KernelCompletionState => this.state;

  /** Code runs in the kernel (a run of this tab): nothing is asked until it ends. */
  setRunning(running: boolean): void {
    if (this.#running === running) return;
    this.#running = running;
    // A run ended or started: the kernel's state changed, so ask again at once.
    if (this.#state !== "unsupported") this.#pausedUntil = 0;
    this.#emit();
  }

  /** The kernel was started or restarted from this tab: ask again at once. */
  kernelChanged(): void {
    if (this.#state === "unsupported" || this.#threadId === null) return;
    this.#pausedUntil = 0;
    this.#set("idle");
  }

  /** Whether a request may be sent now (no thread, a pause, a run, an older agent: no). */
  available(): boolean {
    if (this.#threadId === null || this.#running || this.#state === "unsupported") return false;
    return this.#now() >= this.#pausedUntil;
  }

  /**
   * Completions at `cursor` (a UTF-16 offset into `code`); null when there are none or the
   * kernel can't answer now. Never throws.
   */
  async complete(
    code: string,
    cursor: number,
    signal?: AbortSignal,
  ): Promise<KernelMatches | null> {
    if (utf8.encode(code).length > NOTEBOOK_COMPLETE_CODE_MAX_BYTES) return null;
    if (!isWellFormedText(code)) return null;
    const at = codePoints(code.slice(0, cursor));
    const answer = await this.#ask({ op: "complete", code, cursor: at }, signal);
    if (answer?.status !== "ok" || answer.op !== "complete") return null;
    const { cursorStart, cursorEnd } = answer;
    if (cursorStart > at || cursorEnd < cursorStart || cursorEnd > codePoints(code)) return null;
    return {
      from: utf16Offset(code, cursorStart),
      to: Math.max(utf16Offset(code, cursorEnd), cursor),
      matches: answer.matches.map((m) => ({ label: m.text, type: m.type })),
    };
  }

  /** A dotted name's documentation; null when unknown or the kernel can't answer now. */
  async doc(name: string, signal?: AbortSignal): Promise<KernelDoc | null> {
    if (!DOC_NAME.test(name) || name.length > 256) return null;
    const answer = await this.#ask({ op: "doc", name }, signal);
    if (answer?.status !== "ok" || answer.op !== "doc" || !answer.found) return null;
    if (answer.signature === undefined && answer.doc === undefined) return null;
    return { signature: answer.signature, doc: answer.doc, type: answer.type };
  }

  async #ask(
    body: Parameters<NotebookApi["complete"]>[1],
    signal: AbortSignal | undefined,
  ): Promise<KernelCompletionAnswer | null> {
    if (!this.available() || this.#threadId === null || signal?.aborted) return null;
    // One request in flight per editor: the newest wins, the older one is cancelled (so the
    // kernel never sees two at once from here; review L4).
    this.#inflight?.abort();
    const ctrl = new AbortController();
    this.#inflight = ctrl;
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, KERNEL_COMPLETION_TIMEOUT_MS);
    try {
      const res = await this.#api.complete(this.#threadId, body, ctrl.signal);
      // Cancelled by the next keystroke or a newer request: says nothing about the kernel.
      if (signal?.aborted || this.#inflight !== ctrl) return null;
      if (!res.ok) {
        // Too many requests, or anything else (gone thread, no isolation, a network error, a
        // request that timed out here): the editor keeps its own completion for a while.
        this.#pause(res.error.status === 429 ? "rate_limited" : "unavailable");
        return null;
      }
      const answer = res.data;
      if (answer.status === "ok") this.#set("ready");
      else this.#pause(answer.status);
      return answer;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (this.#inflight === ctrl) this.#inflight = null;
    }
  }

  #pause(state: Exclude<KernelCompletionState, "idle" | "ready" | "no_thread">): void {
    this.#pausedUntil = this.#now() + (KERNEL_BACKOFF_MS[state] ?? 0);
    this.#set(state);
  }

  #set(state: KernelCompletionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}
