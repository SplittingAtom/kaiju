import type { Readable, Writable } from "node:stream";
import { LineSplitter } from "../jsonl.js";

/**
 * One running `kobe-kernel-bridge.py` (images/sandbox/kernel; docs/specs/notebooks.md NB10): the
 * agent's end of its stdio JSON-lines protocol. One execution at a time; the manager queues.
 */
export interface BridgeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** Ends the bridge and its kernel (and, under an identity, everything of that uid). */
  kill(): Promise<void>;
}

/** Starts a bridge for a thread's kernel. */
export type BridgeLauncher = (threadId: string) => Promise<BridgeProcess>;

export type BridgeEvent =
  | { readonly ev: "ready" }
  | { readonly ev: "output"; readonly id: string; readonly output: unknown }
  | {
      readonly ev: "done";
      readonly id: string;
      readonly status: "ok" | "error" | "interrupted";
      readonly execution_count: number | null;
    }
  | {
      readonly ev: "inspected";
      readonly id: string;
      readonly snapshot?: Record<string, unknown>;
      readonly error?: string;
    }
  | {
      readonly ev: "completed";
      readonly id: string;
      readonly result?: Record<string, unknown>;
      readonly error?: string;
    }
  | { readonly ev: "died" }
  | { readonly ev: "fatal"; readonly message: string };

/** The bridge prints at most this much per line (it shrinks larger outputs itself). */
export const BRIDGE_MAX_LINE_BYTES = 2 * 1024 * 1024;

export function parseBridgeLine(line: string): BridgeEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  switch (m.ev) {
    case "ready":
    case "died":
      return { ev: m.ev };
    case "fatal":
      return { ev: "fatal", message: String(m.message ?? "").slice(0, 500) };
    case "output":
      return typeof m.id === "string" ? { ev: "output", id: m.id, output: m.output } : undefined;
    case "inspected": {
      if (typeof m.id !== "string") return undefined;
      const snap = m.snapshot;
      if (typeof snap === "object" && snap !== null && !Array.isArray(snap)) {
        return { ev: "inspected", id: m.id, snapshot: snap as Record<string, unknown> };
      }
      return { ev: "inspected", id: m.id, error: String(m.error ?? "no snapshot").slice(0, 200) };
    }
    case "completed": {
      if (typeof m.id !== "string") return undefined;
      const result = m.result;
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        return { ev: "completed", id: m.id, result: result as Record<string, unknown> };
      }
      return { ev: "completed", id: m.id, error: String(m.error ?? "no answer").slice(0, 200) };
    }
    case "done": {
      const status = m.status;
      if (typeof m.id !== "string") return undefined;
      if (status !== "ok" && status !== "error" && status !== "interrupted") return undefined;
      const count = m.execution_count;
      return {
        ev: "done",
        id: m.id,
        status,
        execution_count: typeof count === "number" && Number.isInteger(count) ? count : null,
      };
    }
    default:
      return undefined;
  }
}

/** How an execution ended, as the bridge saw it; `gone`: the bridge or kernel went away. */
export type SessionResult =
  | {
      readonly kind: "done";
      readonly status: "ok" | "error" | "interrupted";
      readonly executionCount: number | null;
    }
  | { readonly kind: "gone"; readonly message: string };

/** How a variables snapshot ended (KOBE-803): the bridge's object, untrusted until validated. */
export type InspectResult =
  | { readonly kind: "done"; readonly snapshot: Record<string, unknown> }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "gone"; readonly message: string };

/** How a completion or documentation request ended (KOBE-808): the bridge's answer, untrusted. */
export type CompleteResult =
  | { readonly kind: "done"; readonly result: Record<string, unknown> }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "gone"; readonly message: string };

/** What the bridge's `complete` / `doc` ops take. */
export type CompleteRequest =
  | {
      readonly op: "complete";
      readonly code: string;
      readonly cursor: number;
      readonly timeout_ms: number;
    }
  | { readonly op: "doc"; readonly name: string; readonly timeout_ms: number };

interface Completing {
  readonly id: string;
  readonly resolve: (result: CompleteResult) => void;
}

/** The snapshot's caps, as the bridge takes them (`INSPECT_LIMIT_KEYS`). */
export interface InspectLimits {
  readonly max_vars: number;
  readonly max_bytes: number;
  readonly repr_chars: number;
  readonly columns_max: number;
  readonly per_var_ms: number;
  readonly budget_ms: number;
}

interface Inspecting {
  readonly id: string;
  readonly resolve: (result: InspectResult) => void;
}

interface Running {
  readonly id: string;
  readonly onOutput: (output: unknown) => void;
  readonly resolve: (result: SessionResult) => void;
}

export class KernelSession {
  readonly #proc: BridgeProcess;
  readonly #diagnostic: (message: string) => void;
  #ready: Promise<void>;
  #running: Running | undefined;
  #inspecting: Inspecting | undefined;
  #completing: Completing | undefined;
  #goneReason: string | undefined;
  #stopping: Promise<void> | undefined;
  #onReady: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(proc: BridgeProcess, diagnostic: (message: string) => void) {
    this.#proc = proc;
    this.#diagnostic = diagnostic;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#onReady = { resolve, reject };
    });
    // A rejection nobody awaited yet must not crash the agent.
    this.#ready.catch(() => undefined);
    const splitter = new LineSplitter({
      maxLineBytes: BRIDGE_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line),
      onOversize: (bytes) => this.#diagnostic(`kernel bridge line of ${bytes} bytes dropped`),
    });
    proc.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    proc.stdout.on("error", () => undefined);
    proc.stdin.on("error", () => undefined);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    proc.stderr.on("error", () => undefined);
    void proc.exited.then(({ code, signal }) => {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      this.#gone(`the kernel bridge exited (${signal ?? code})${tail ? `: ${tail}` : ""}`);
    });
  }

  get alive(): boolean {
    return this.#goneReason === undefined;
  }

  get busy(): boolean {
    return this.#running !== undefined;
  }

  /** A variables snapshot was asked for and the bridge has not answered it yet (KOBE-803). */
  get inspecting(): boolean {
    return this.#inspecting !== undefined;
  }

  /** A completion or documentation request is in the bridge (KOBE-808). */
  get completing(): boolean {
    return this.#completing !== undefined;
  }

  /** Resolves once the kernel answered; rejects if the bridge fails first or `timeoutMs` passes. */
  ready(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the kernel did not start in time")), timeoutMs);
    });
    return Promise.race([this.#ready, timeout]).finally(() => clearTimeout(timer));
  }

  execute(id: string, code: string, onOutput: (output: unknown) => void): Promise<SessionResult> {
    if (this.#goneReason !== undefined) {
      return Promise.resolve({ kind: "gone", message: this.#goneReason });
    }
    if (this.#running !== undefined || this.#inspecting !== undefined) {
      throw new Error("the kernel is busy");
    }
    return new Promise<SessionResult>((resolve) => {
      this.#running = { id, onOutput, resolve };
      this.#write({ op: "execute", id, code });
    });
  }

  /**
   * KOBE-803: snapshot the kernel's user variables (a silent request: no execution count). One at
   * a time and never during an execution; resolves when the bridge answers or the kernel goes.
   */
  inspect(id: string, limits: InspectLimits): Promise<InspectResult> {
    if (this.#goneReason !== undefined) {
      return Promise.resolve({ kind: "gone", message: this.#goneReason });
    }
    if (this.#running !== undefined || this.#inspecting !== undefined) {
      throw new Error("the kernel is busy");
    }
    return new Promise<InspectResult>((resolve) => {
      this.#inspecting = { id, resolve };
      this.#write({ op: "inspect", id, limits });
    });
  }

  /**
   * KOBE-808: completions or a name's documentation (silent requests: no execution count, no
   * code of the member's runs). One at a time; an execution sent meanwhile waits in the bridge
   * behind it, which answers within the request's own `timeout_ms`. Past `waitMs` this answers
   * `timeout` and forgets the request (a late answer is dropped by its id).
   */
  complete(id: string, request: CompleteRequest, waitMs: number): Promise<CompleteResult> {
    if (this.#goneReason !== undefined) {
      return Promise.resolve({ kind: "gone", message: this.#goneReason });
    }
    if (this.#completing !== undefined) throw new Error("a completion is already in the kernel");
    return new Promise<CompleteResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#completing?.id === id) this.#completing = undefined;
        resolve({ kind: "timeout" });
      }, waitMs);
      timer.unref();
      this.#completing = {
        id,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      this.#write({ ...request, id });
    });
  }

  interrupt(): void {
    this.#write({ op: "interrupt" });
  }

  /** Stops the bridge (and its kernel); a running execution ends `gone`. Idempotent. */
  stop(reason: string): Promise<void> {
    this.#stopping ??= (async () => {
      this.#write({ op: "shutdown" });
      this.#proc.stdin.end();
      this.#gone(reason);
      await this.#proc.kill();
    })();
    return this.#stopping;
  }

  #write(message: Record<string, unknown>): void {
    if (this.#goneReason !== undefined || this.#proc.stdin.writableEnded) return;
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    const event = parseBridgeLine(line);
    if (event === undefined) {
      this.#diagnostic("malformed line from the kernel bridge");
      return;
    }
    switch (event.ev) {
      case "ready":
        this.#onReady?.resolve();
        return;
      case "fatal":
        this.#diagnostic(`kernel bridge: ${event.message}`);
        if (this.#running === undefined) this.#onReady?.reject(new Error(event.message));
        return;
      case "died":
        this.#gone("the kernel stopped");
        return;
      case "output":
        if (this.#running?.id === event.id) this.#running.onOutput(event.output);
        return;
      case "inspected": {
        const inspecting = this.#inspecting;
        if (inspecting?.id !== event.id) return;
        this.#inspecting = undefined;
        inspecting.resolve(
          event.snapshot === undefined
            ? { kind: "failed", message: event.error ?? "no snapshot" }
            : { kind: "done", snapshot: event.snapshot },
        );
        return;
      }
      case "completed": {
        const completing = this.#completing;
        if (completing?.id !== event.id) return;
        this.#completing = undefined;
        completing.resolve(
          event.result === undefined
            ? { kind: "failed", message: event.error ?? "no answer" }
            : { kind: "done", result: event.result },
        );
        return;
      }
      case "done": {
        const running = this.#running;
        if (running?.id !== event.id) return;
        this.#running = undefined;
        running.resolve({
          kind: "done",
          status: event.status,
          executionCount: event.execution_count,
        });
        return;
      }
    }
  }

  #gone(reason: string): void {
    if (this.#goneReason !== undefined) return;
    this.#goneReason = reason;
    this.#onReady?.reject(new Error(reason));
    const running = this.#running;
    this.#running = undefined;
    running?.resolve({ kind: "gone", message: reason });
    const inspecting = this.#inspecting;
    this.#inspecting = undefined;
    inspecting?.resolve({ kind: "gone", message: reason });
    const completing = this.#completing;
    this.#completing = undefined;
    completing?.resolve({ kind: "gone", message: reason });
  }
}
