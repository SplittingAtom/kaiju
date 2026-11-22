import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  NotebookExecuteResult,
  NotebookKernelResponse,
  NotebookOutput,
  NotebookStartResult,
  NotebookTiming,
  NotebookVariablesResult,
  NotebookVariablesSnapshot,
} from "@kobe/protocol";
import type { NotebookCompletionFrame, NotebookExecuteFrame } from "@kobe/protocol/sandbox-wire";
import { askKernel } from "./completion.js";
import { fail, ok, type CommandOutcome } from "../threads/outcome.js";
import { OUTPUT_LIMITS, OutputLimiter, type OutputLimits } from "./outputs.js";
import { KernelSession, type BridgeLauncher } from "./session.js";
import {
  AFTER_RUN_INSPECT_TIMEOUT_MS,
  INSPECT_LIMITS,
  UNAVAILABLE,
  snapshotResult,
} from "./variables.js";

/**
 * The thread kernels of one sandbox (KOBE-464; docs/specs/notebooks.md NB2, NB7, NB8, NB10). A
 * kernel starts on its thread's first `notebook.execute` (or a `notebook.restart` with `op: "start"`,
 * KOBE-477), runs one execution at a time (the rest
 * wait in order), stops after `idleMs` without use, on `notebook.restart` and when the agent stops.
 * At most `maxKernels` live at once: a new one first stops the least recently used idle kernel,
 * and is refused (`kernel_unavailable`) when every kernel is busy. Each execution has a deadline
 * counted from its arrival (waiting included): at `timeout_ms` the kernel is interrupted, `graceMs`
 * later it is stopped (state lost). An execution still waiting is never run once its deadline
 * passed, its run ended, or the thread was interrupted: the server has given up on it (NB8).
 *
 * KOBE-803: an execution reports when it ran (`with_timing`); with `with_variables` (a member's
 * run) a variables snapshot is taken right after it and kept in memory with the kernel (replaced by
 * the next one, gone with the kernel), never sent with the result. `inspect` answers from the kept
 * snapshot while code runs (`stale`) or when nothing ran since it was taken, and takes a fresh one
 * otherwise (or when asked to refresh). A snapshot never waits for an execution (no kept one:
 * `busy`), never starts a kernel (`no_kernel`), and past its timeout answers `unavailable` (the
 * kernel is interrupted to end it). An execution never waits on a snapshot either: it interrupts a
 * snapshot still running and, if that does not end it within the grace, restarts the kernel.
 */
export interface KernelManagerOptions {
  readonly launch: BridgeLauncher;
  readonly maxKernels: number;
  readonly idleMs: number;
  readonly readyTimeoutMs?: number;
  readonly graceMs?: number;
  /** How long the snapshot after a member's run may take (default 3 s). */
  readonly afterRunInspectMs?: number;
  readonly limits?: OutputLimits;
  readonly log: (message: string, threadId?: string) => void;
}

export const KERNEL_READY_TIMEOUT_MS = 60_000;
export const KERNEL_GRACE_MS = 5_000;

type ExecStatus = NotebookExecuteResult["status"];

/** An execution waiting for its kernel: cancelled by an interrupt or the end of its run. */
interface Waiting {
  readonly runId: string;
  readonly deadlineAt: number;
  cancelled: boolean;
  /** Wakes the execution if it is waiting for a snapshot to end. */
  wake?: (() => void) | undefined;
}

interface Kernel {
  readonly threadId: string;
  readonly session: KernelSession;
  /** Executions of this kernel, chained so they run one at a time. */
  tail: Promise<unknown>;
  queued: number;
  lastUsed: number;
  idle: NodeJS.Timeout | undefined;
  /** Why the kernel is being stopped while an execution runs (decides that execution's status). */
  stopping: ExecStatus | undefined;
  current: { readonly runId: string; readonly execId: string } | undefined;
  readonly waiting: Set<Waiting>;
  /** Settles once the bridge answered the last snapshot (or the kernel went). */
  inspection: Promise<void>;
  /** The last snapshot taken (KOBE-803), and whether no code has run since. */
  kept: NotebookVariablesSnapshot | undefined;
  keptCurrent: boolean;
}

export type OutputSink = (index: number, output: NotebookOutput) => void;

export class KernelManager {
  readonly #o: KernelManagerOptions;
  readonly #kernels = new Map<string, Kernel>();
  /**
   * Threads whose automatic (after-run and route) snapshots are paused (KOBE-803 review): one
   * taken after a run timed out. Kept here, not on the kernel, so it outlives a kernel restart;
   * gone when the sandbox restarts. Only an explicit `refresh` takes a snapshot then.
   */
  readonly #autoPaused = new Set<string>();
  readonly #starting = new Map<string, Promise<Kernel>>();
  #closed = false;

  constructor(options: KernelManagerOptions) {
    this.#o = options;
  }

  get size(): number {
    return this.#kernels.size;
  }

  /** `notebook.execute`: runs the code, streams outputs to `sink`, answers how it ended. */
  async execute(frame: NotebookExecuteFrame, sink: OutputSink): Promise<CommandOutcome> {
    if (this.#closed) return fail("kernel_unavailable", "the sandbox is stopping");
    const waiting: Waiting = {
      runId: frame.run_id,
      deadlineAt: Date.now() + frame.timeout_ms,
      cancelled: false,
    };
    const got = await this.#acquire(frame.thread_id);
    if (!got.ok) return got.outcome;
    const kernel = got.kernel;
    kernel.queued += 1;
    kernel.waiting.add(waiting);
    const run = kernel.tail.then(() => this.#run(kernel, frame, sink, waiting));
    kernel.tail = run.catch(() => undefined);
    try {
      return ok(await run);
    } catch (error) {
      return fail("internal", (error as Error).message);
    } finally {
      kernel.queued -= 1;
      kernel.waiting.delete(waiting);
      this.#touch(kernel);
    }
  }

  /**
   * `notebook.restart` with `op: "start"` (KOBE-477): the thread's kernel is started if it has none
   * (a live one is kept) and runs nothing; it idles out like any other. Answers `idle` or `busy`.
   */
  async start(threadId: string): Promise<CommandOutcome> {
    if (this.#closed) return fail("kernel_unavailable", "the sandbox is stopping");
    const got = await this.#acquire(threadId);
    if (!got.ok) return got.outcome;
    const busy = got.kernel.queued > 0 || got.kernel.session.busy;
    this.#touch(got.kernel);
    return ok(this.#status(busy ? "busy" : "idle"));
  }

  /** `notebook.inspect` (KOBE-803): the thread kernel's variables, never starting a kernel. */
  async inspect(threadId: string, timeoutMs: number, refresh = false): Promise<CommandOutcome> {
    const paused = this.#autoPaused.has(threadId);
    const answer = (r: NotebookVariablesResult): CommandOutcome =>
      ok(paused ? { ...r, auto_paused: "snapshot_timeout" } : r);
    const kernel = this.#kernels.get(threadId);
    if (this.#closed || kernel === undefined || !kernel.session.alive) {
      return answer({ status: "no_kernel" });
    }
    const kept = kernel.kept;
    if (kernel.queued > 0 || kernel.session.busy || kernel.session.inspecting) {
      return answer(kept === undefined ? { status: "busy" } : { ...kept, stale: true });
    }
    if (!refresh && kept !== undefined && (kernel.keptCurrent || paused)) {
      return answer({ ...kept, stale: !kernel.keptCurrent });
    }
    // Paused: nothing is taken without an explicit refresh.
    if (!refresh && paused) return answer(UNAVAILABLE);
    kernel.queued += 1;
    // An explicit snapshot that times out only answers `unavailable`: the kernel is left alone
    // (interrupted once); a later run restarts it only if the snapshot is still stuck then.
    const snap = kernel.tail.then(() => this.#inspectNow(kernel, timeoutMs, false));
    kernel.tail = snap.catch(() => undefined);
    try {
      return answer(await snap);
    } catch (error) {
      this.#o.log(`variables snapshot failed: ${(error as Error).message}`, threadId);
      return answer(UNAVAILABLE);
    } finally {
      kernel.queued -= 1;
      this.#touch(kernel);
    }
  }

  /**
   * `notebook.inspect` with `op: "complete"` / `"doc"` (KOBE-808): the editor's kernel completion.
   * Never starts a kernel (`no_kernel`) and never waits: while code runs or waits, a snapshot is
   * taken or another request is in the kernel, the answer is `busy`; past the frame's timeout it
   * is `unavailable`. A request keeps the kernel from idling out, like any other use.
   */
  async complete(frame: NotebookCompletionFrame): Promise<CommandOutcome> {
    const kernel = this.#kernels.get(frame.thread_id);
    if (this.#closed || kernel === undefined || !kernel.session.alive) {
      return ok({ status: "no_kernel" });
    }
    const s = kernel.session;
    if (kernel.queued > 0 || s.busy || s.inspecting || s.completing) return ok({ status: "busy" });
    this.#touch(kernel);
    return ok(await askKernel(s, frame, (m) => this.#o.log(m, frame.thread_id)));
  }

  /**
   * `notebook.interrupt` (also the member's Stop): SIGINT to the running cell (state kept), and
   * every execution still waiting is dropped.
   */
  interrupt(threadId: string): CommandOutcome {
    const kernel = this.#kernels.get(threadId);
    if (kernel === undefined) return ok(this.#status("no_kernel"));
    for (const w of kernel.waiting) {
      w.cancelled = true;
      w.wake?.();
    }
    const dropped = kernel.waiting.size > 0;
    // A snapshot stuck in a repr (KOBE-803) is ended like a cell; it ran no code of the member's.
    if (kernel.session.inspecting) kernel.session.interrupt();
    if (!kernel.session.busy) return ok(this.#status(dropped ? "interrupted" : "idle"));
    kernel.session.interrupt();
    return ok(this.#status("interrupted"));
  }

  /** `notebook.restart`: stops the kernel; the next execution starts a fresh one. */
  async restart(threadId: string): Promise<CommandOutcome> {
    const kernel = this.#kernels.get(threadId);
    if (kernel === undefined) return ok(this.#status("no_kernel"));
    await this.#stop(kernel, "restarted", "restarted by the user");
    return ok(this.#status("restarted"));
  }

  /** A run ended (Stop, failure, Pi gone): its running cell is interrupted, its waiting ones dropped. */
  runEnded(runId: string): void {
    for (const kernel of this.#kernels.values()) {
      for (const w of kernel.waiting) {
        if (w.runId !== runId) continue;
        w.cancelled = true;
        w.wake?.();
      }
      if (kernel.current?.runId === runId && kernel.session.busy) kernel.session.interrupt();
    }
  }

  /** The agent stops (hibernation, SIGTERM): every kernel goes (NB2). */
  async stopAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#kernels.values()].map((k) => this.#stop(k, "restarted")));
  }

  #status<S extends NotebookKernelResponse["status"] | NotebookStartResult["status"]>(
    status: S,
  ): { status: S } {
    return { status };
  }

  async #acquire(
    threadId: string,
  ): Promise<{ ok: true; kernel: Kernel } | { ok: false; outcome: CommandOutcome }> {
    try {
      return { ok: true, kernel: await this.#kernelFor(threadId) };
    } catch (error) {
      this.#o.log(`kernel start failed: ${(error as Error).message}`, threadId);
      return { ok: false, outcome: fail("kernel_unavailable", (error as Error).message) };
    }
  }

  async #run(
    kernel: Kernel,
    frame: NotebookExecuteFrame,
    sink: OutputSink,
    waiting: Waiting,
  ): Promise<NotebookExecuteResult> {
    const limiter = new OutputLimiter(sink, this.#o.limits ?? OUTPUT_LIMITS);
    // An execution never waits on a snapshot (KOBE-803): one still running is interrupted, and a
    // kernel it holds past the grace is restarted.
    if (kernel.session.inspecting && !(await this.#endInspection(kernel, waiting))) {
      kernel.waiting.delete(waiting);
      limiter.note(
        "[Kobe: the kernel was stuck showing its variables and was restarted; run it again]\n",
      );
      return { status: "restarted", execution_count: null, ...limiter.finish() };
    }
    kernel.waiting.delete(waiting);
    if (waiting.cancelled) {
      limiter.note("[Kobe: not run: interrupted, or its run ended, before it started]\n");
      return { status: "interrupted", execution_count: null, ...limiter.finish() };
    }
    const remaining = waiting.deadlineAt - Date.now();
    if (remaining <= 0) {
      limiter.note("[Kobe: not run: its time ran out while it waited for the kernel]\n");
      return { status: "timeout", execution_count: null, ...limiter.finish() };
    }
    if (!kernel.session.alive) {
      limiter.note("[Kobe: the kernel stopped before this cell ran; run it again]\n");
      return { status: "restarted", execution_count: null, ...limiter.finish() };
    }
    kernel.current = { runId: frame.run_id, execId: frame.exec_id };
    let timedOut = false;
    const grace = this.#o.graceMs ?? KERNEL_GRACE_MS;
    let kill: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      kernel.session.interrupt();
      kill = setTimeout(() => void this.#stop(kernel, "timeout", "the cell timed out"), grace);
    }, remaining);
    const startedAt = new Date();
    const started = performance.now();
    kernel.keptCurrent = false;
    let ran: NotebookExecuteResult;
    let snapshot = false;
    try {
      const result = await kernel.session.execute(frame.exec_id, frame.code, (o) =>
        limiter.push(o),
      );
      if (result.kind === "done") {
        const status: ExecStatus = timedOut ? "timeout" : result.status;
        if (timedOut) limiter.note(`[Kobe: the cell ran past its ${frame.timeout_ms / 1000} s]\n`);
        ran = { status, execution_count: result.executionCount, ...limiter.finish() };
        snapshot = !timedOut;
      } else {
        // The bridge or the kernel went away.
        const status: ExecStatus = kernel.stopping ?? (timedOut ? "timeout" : "error");
        limiter.note(stopNote(status));
        void this.#stop(kernel, status, result.message);
        ran = { status, execution_count: null, ...limiter.finish() };
      }
    } finally {
      clearTimeout(deadline);
      if (kill !== undefined) clearTimeout(kill);
      kernel.current = undefined;
    }
    const timing: NotebookTiming = {
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
    };
    // A member's run: the snapshot after it is kept for `notebook.inspect`, never returned.
    if (
      frame.with_variables === true &&
      snapshot &&
      kernel.session.alive &&
      !this.#autoPaused.has(kernel.threadId)
    ) {
      await this.#inspectNow(
        kernel,
        this.#o.afterRunInspectMs ?? AFTER_RUN_INSPECT_TIMEOUT_MS,
        true,
      );
    }
    return { ...ran, ...(frame.with_timing === true ? { timing } : {}) };
  }

  /**
   * Interrupts a snapshot still running and waits for it to end, at most the grace (or until the
   * execution's deadline, or until it is cancelled). False when it did not end: the kernel was
   * stopped (its state is lost; a snapshot stuck in C code can't be ended any other way).
   */
  async #endInspection(kernel: Kernel, waiting: Waiting): Promise<boolean> {
    kernel.session.interrupt();
    const grace = Math.max(
      0,
      Math.min(this.#o.graceMs ?? KERNEL_GRACE_MS, waiting.deadlineAt - Date.now()),
    );
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      kernel.inspection.then(() => "ended" as const),
      new Promise<"cancelled">((resolve) => {
        waiting.wake = () => resolve("cancelled");
      }),
      new Promise<"stuck">((resolve) => {
        timer = setTimeout(() => resolve("stuck"), grace);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      waiting.wake = undefined;
    });
    if (outcome !== "stuck") return true;
    await this.#stop(kernel, "restarted", "a variables snapshot did not end");
    return false;
  }

  /**
   * Takes a snapshot now (the caller holds the kernel's tail). Answers within `timeoutMs`; past it
   * the kernel is interrupted; `kernel.inspection` settles once the bridge answered, and the next
   * execution waits for that (at most the grace, `#endInspection`), so the interrupt never reaches
   * a later cell. An `ok` snapshot becomes the kept one.
   */
  async #inspectNow(
    kernel: Kernel,
    timeoutMs: number,
    auto: boolean,
  ): Promise<NotebookVariablesResult> {
    if (!kernel.session.alive) return { status: "no_kernel" };
    const takenAt = new Date();
    const pending = kernel.session.inspect(randomUUID(), INSPECT_LIMITS);
    kernel.inspection = pending.then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const got = await Promise.race([pending, late]).finally(() => clearTimeout(timer));
    const log = (m: string) => this.#o.log(m, kernel.threadId);
    if (got === undefined) {
      log("variables snapshot timed out; interrupting it");
      if (auto) {
        // One stuck automatic snapshot pauses them for this thread (until the sandbox restarts).
        this.#autoPaused.add(kernel.threadId);
        log("automatic variables snapshots paused for this thread");
      }
      if (kernel.session.inspecting) kernel.session.interrupt();
      return UNAVAILABLE;
    }
    const result = snapshotResult(got, takenAt, log);
    if (result.status !== "ok") return result;
    kernel.kept = result;
    kernel.keptCurrent = true;
    return { ...result, stale: false };
  }

  async #kernelFor(threadId: string): Promise<Kernel> {
    const live = this.#kernels.get(threadId);
    if (live !== undefined && live.session.alive) return live;
    if (live !== undefined) await this.#stop(live, "restarted");
    const pending = this.#starting.get(threadId);
    if (pending !== undefined) return pending;
    const starting = this.#start(threadId).finally(() => this.#starting.delete(threadId));
    this.#starting.set(threadId, starting);
    return starting;
  }

  async #start(threadId: string): Promise<Kernel> {
    await this.#makeRoom();
    const proc = await this.#o.launch(threadId);
    const session = new KernelSession(proc, (m) => this.#o.log(m, threadId));
    try {
      await session.ready(this.#o.readyTimeoutMs ?? KERNEL_READY_TIMEOUT_MS);
    } catch (error) {
      await session.stop("start failed").catch(() => undefined);
      throw error;
    }
    if (this.#closed) {
      await session.stop("the sandbox is stopping");
      throw new Error("the sandbox is stopping");
    }
    const kernel: Kernel = {
      threadId,
      session,
      tail: Promise.resolve(),
      queued: 0,
      lastUsed: Date.now(),
      idle: undefined,
      stopping: undefined,
      current: undefined,
      waiting: new Set(),
      inspection: Promise.resolve(),
      kept: undefined,
      keptCurrent: false,
    };
    this.#kernels.set(threadId, kernel);
    this.#o.log("kernel started", threadId);
    return kernel;
  }

  /** Below the cap, or the least recently used idle kernel is stopped; else refused. */
  async #makeRoom(): Promise<void> {
    if (this.#kernels.size + this.#starting.size < this.#o.maxKernels) return;
    const idle = [...this.#kernels.values()]
      .filter((k) => k.queued === 0 && !k.session.busy && !k.session.inspecting)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle === undefined) {
      throw new Error(`all ${this.#o.maxKernels} kernels of this sandbox are busy; try again`);
    }
    await this.#stop(idle, "restarted", "stopped to make room for another thread's kernel");
  }

  #touch(kernel: Kernel): void {
    kernel.lastUsed = Date.now();
    if (kernel.idle !== undefined) clearTimeout(kernel.idle);
    kernel.idle = undefined;
    if (kernel.queued > 0 || this.#kernels.get(kernel.threadId) !== kernel) return;
    kernel.idle = setTimeout(() => {
      if (kernel.queued === 0 && !kernel.session.busy && !kernel.session.inspecting) {
        void this.#stop(kernel, "restarted", "idle");
      }
    }, this.#o.idleMs);
    kernel.idle.unref();
  }

  async #stop(kernel: Kernel, why: ExecStatus, reason = "stopped"): Promise<void> {
    kernel.stopping ??= why;
    if (kernel.idle !== undefined) clearTimeout(kernel.idle);
    if (this.#kernels.get(kernel.threadId) === kernel) this.#kernels.delete(kernel.threadId);
    this.#o.log(`kernel stopped: ${reason}`, kernel.threadId);
    await kernel.session.stop(reason).catch((error: unknown) => {
      this.#o.log(`stopping a kernel failed: ${(error as Error).message}`, kernel.threadId);
    });
  }
}

function stopNote(status: ExecStatus): string {
  if (status === "restarted") return "[Kobe: the kernel was restarted; its state is lost]\n";
  if (status === "timeout") return "[Kobe: the cell timed out and the kernel was stopped]\n";
  return "[Kobe: the kernel stopped unexpectedly; its state is lost]\n";
}
