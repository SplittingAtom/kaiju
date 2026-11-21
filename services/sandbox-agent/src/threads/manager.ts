import type {
  PiExtensionUiRequest,
  PiSessionHeader,
  RunStartFrame,
  RunStopFrame,
  WorkspaceConflictNoteFrame,
} from "@kobe/protocol";
import { buildPiLaunch } from "../pi/pi-launch.js";
import {
  type SessionRestore,
  appendAppCards,
  appendBranchMarker,
  missingAppCards,
  ensureSessionDir,
  sessionFilePath,
} from "../pi/session-files.js";
import { SkillError } from "../skills/store.js";
import {
  AttachmentPathError,
  confineAttachment,
  nativeImages,
  promptWithAttachments,
} from "./attachments.js";
import { fail, ok, type CommandOutcome } from "./outcome.js";
import type { CompactReply } from "./compact.js";
import type { BranchSummaryReply } from "./branch-summary.js";
import { runBranchSummary, runCompaction } from "./compaction.js";
import type { Frame, ManagerPort, ThreadManagerOptions } from "./manager-options.js";
import {
  PI_REQUEST_TIMEOUT_MS,
  PI_SLOW_REQUEST_TIMEOUT_MS,
  dispositionOf,
  piFailure,
  raceTimeout,
  runModelOf,
  withTimeout,
} from "./manager-util.js";
import { readContext, restoreSession, runPiCommand } from "./session-commands.js";
import { Thread } from "./thread.js";
import type { RunModel } from "../models/types.js";

/** Upper bound for the KOBE-27 `beforeRun` hook (workspace sync) before a run gives up. */
export const BEFORE_RUN_TIMEOUT_MS = 5 * 60_000;
const ABORT_SETTLE_GRACE_MS = 5000;
/** A run.start that takes longer than this before Pi has its prompt is logged with its stages. */
const SLOW_START_WARN_MS = 5000;

/**
 * Supervises one `pi --mode rpc` process per active thread (D13), all sharing /workspace, and maps
 * server commands onto Pi RPC: run.start → prompt, run.steer → steer, run.stop → clear_queue +
 * abort, pi.command → the allow-listed command, session.restore → the thread's session file.
 */
export class ThreadManager {
  readonly #options: ThreadManagerOptions;
  readonly #threads = new Map<string, Thread>();
  readonly #restores = new Map<string, SessionRestore>();
  #pendingSpawns = 0;
  readonly #evicting = new Set<Thread>();
  /** run.start commands in progress, by run id (a Stop may arrive before the run begins). */
  readonly #starting = new Map<string, PendingStart>();
  readonly #reaper: NodeJS.Timeout;
  readonly #unsubscribeTokens: (() => void) | undefined;
  readonly #unsubscribeEgress: (() => void) | undefined;
  readonly #unsubscribeMcp: (() => void) | undefined;
  #draining = false;
  /** What the compaction and session commands use of this manager (`ManagerPort`). */
  readonly #port: ManagerPort;

  constructor(options: ThreadManagerOptions) {
    this.#options = options;
    this.#port = {
      options,
      restores: this.#restores,
      draining: () => this.#draining,
      ensureProcess: (thread, frame, model) => this.#ensureProcess(thread, frame, model),
      sessionFile: (threadId) => this.#sessionFile(threadId),
      defaultHeader: (threadId) => this.#defaultHeader(threadId),
      endRestore: (thread) => this.#endRestore(thread),
      warn: (threadId, message) => this.#warn(threadId, message),
    };
    this.#reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, options.idleMs));
    this.#reaper.unref();
    // A rotated model-gateway token reaches every live Pi's model file (KOBE-41).
    this.#unsubscribeTokens = options.models?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateToken(token);
    });
    // A rotated mcp-proxy token reaches every live Pi's mcp.json (KOBE-111).
    this.#unsubscribeMcp = options.mcp?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateMcpToken(token);
    });
    // A rotated egress token reaches every live Pi's egress token file (KOBE-39).
    this.#unsubscribeEgress = options.egress?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateEgressToken(token);
    });
  }

  get draining(): boolean {
    return this.#draining;
  }

  activeRuns(): { runId: string; threadId: string }[] {
    return [...this.#threads.values()].flatMap((t) =>
      t.runId === undefined ? [] : [{ runId: t.runId, threadId: t.id }],
    );
  }

  pendingDialogs(): {
    threadId: string;
    runId: string | undefined;
    request: PiExtensionUiRequest;
  }[] {
    return [...this.#threads.values()].flatMap((t) =>
      t.pendingDialogs.map((request) => ({ threadId: t.id, runId: t.runId, request })),
    );
  }

  startRun(frame: RunStartFrame): Promise<CommandOutcome> {
    // Known from the moment it arrives, so a Stop that overtakes it (Pi still starting) is kept.
    const existing = this.#starting.get(frame.run_id);
    let settle: () => void = () => undefined;
    const pending: PendingStart = existing ?? {
      threadId: frame.thread_id,
      stopped: false,
      done: new Promise<void>((resolve) => (settle = resolve)),
    };
    if (existing === undefined) this.#starting.set(frame.run_id, pending);
    return this.#claimed(frame.thread_id, (thread) =>
      this.#startRun(thread, frame, pending),
    ).finally(() => {
      if (existing !== undefined) return;
      this.#starting.delete(frame.run_id);
      settle();
    });
  }

  async #startRun(
    thread: Thread,
    frame: RunStartFrame,
    pending: PendingStart,
  ): Promise<CommandOutcome> {
    if (this.#draining) return fail("pi_unavailable", "sandbox is shutting down");
    if (thread.runId === frame.run_id) return ok({ already_started: true });
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    const attachmentError = await this.#checkAttachments(frame);
    if (attachmentError !== undefined) return fail("pi_rejected", attachmentError);
    const model = runModelOf(frame);
    if (this.#options.models !== undefined && model === null) {
      // The server found no model for the run (no team default): say so before any Pi work.
      return fail("model_not_configured", "no model is enabled for this team");
    }

    if (pending.stopped) return this.#stoppedBeforePrompt(thread, frame);
    const prepared = await thread.withLock(() => this.#prepareRun(thread, frame));
    if (prepared !== undefined) return prepared;
    if (pending.stopped) return this.#stoppedBeforePrompt(thread, frame);
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");

    thread.beginRun(frame.run_id);
    thread.setPreparing(true);
    // Until the prompt goes out a Stop ends the run at once (#abort: Pi has none of it), and
    // another run may then hold the thread: this start ends only its own run from here on.
    const own = () => thread.runId === frame.run_id;
    const endOwn = () => {
      if (own()) thread.endRun();
    };
    const began = Date.now();
    const stages: string[] = [];
    const mark = (stage: string) => stages.push(`${stage} ${Date.now() - began} ms`);
    try {
      // The tripwire first (before the run's own write to the model file would hide a rewrite).
      const tampered = await thread.verifyRuntime();
      if (tampered !== undefined) {
        await thread.withLock(() => thread.stopProcess());
        endOwn();
        return fail("runtime_tampered", tampered);
      }
      try {
        await thread.attachRun(
          frame.run_id,
          model,
          frame.run_token?.token,
          this.#options.traceparentOf?.(frame.run_id) ?? null,
        );
        // The run's memory (KOBE-157): its own file, so a changed index never restarts Pi.
        // Project instructions (KOBE-245) only for an agent that announced `projects`.
        // The viewed file (KOBE-462) only for an agent that announced `file_edits`.
        await thread.attachMemory(
          frame.memory,
          this.#options.projectTools ? frame.project : undefined,
          this.#options.fileEditTools ? frame.viewing : undefined,
          frame.sync_conflicts,
        );
      } catch (error) {
        endOwn();
        return fail("pi_unavailable", `model file not written: ${(error as Error).message}`);
      }
      // And once more with the run's file in place: the prompt goes out right after this.
      const tamperedAfter = await thread.verifyRuntime();
      if (tamperedAfter !== undefined) {
        await thread.withLock(() => thread.stopProcess());
        endOwn();
        return fail("runtime_tampered", tamperedAfter);
      }
      mark("attached");
      if (this.#options.beforeRun !== undefined) {
        const timedOut = await withTimeout(
          this.#options.beforeRun(frame),
          this.#options.beforeRunTimeoutMs ?? BEFORE_RUN_TIMEOUT_MS,
        );
        if (timedOut) {
          this.#warn(thread.id, `run ${frame.run_id}: workspace preparation timed out`);
          endOwn();
          return fail("internal", "workspace preparation timed out");
        }
      }
      mark("workspace ready");
      // The files are in place now: confine them again (the model can write symlinks into the
      // workspace) and read the images Pi gets inline.
      const media = await this.#promptMedia(frame);
      if (typeof media === "string") {
        endOwn();
        return fail("pi_rejected", media);
      }
      if (!own()) return this.#stoppedBeforePrompt(thread, frame);
      // From here on Pi has the run: a Stop aborts it in Pi (#abort).
      thread.setPreparing(false);
      const response = await thread.request(
        {
          type: "prompt",
          message: promptWithAttachments(frame.message, frame.attachments ?? [], media.inlined),
          ...(media.images.length > 0 ? { images: media.images } : {}),
          ...(thread.streaming ? { streamingBehavior: "followUp" } : {}),
        },
        PI_REQUEST_TIMEOUT_MS,
      );
      if (!response.success) {
        endOwn();
        return fail("pi_rejected", response.error);
      }
      mark("prompt taken");
      // A start this slow is what a Stop or a second message meets as a busy thread: say where.
      if (Date.now() - began > SLOW_START_WARN_MS) {
        this.#warn(thread.id, `run ${frame.run_id} started slowly: ${stages.join(", ")}`);
      }
      const disposition = dispositionOf(response.data);
      if (disposition === "handled") endOwn();
      return ok({ disposition });
    } catch (error) {
      // Pi may still act on the prompt: stop it rather than leave it working without a run.
      if (own()) await thread.withLock(() => thread.stopProcess());
      endOwn();
      return piFailure(error);
    }
  }

  async steerRun(frame: Frame<"run.steer">): Promise<CommandOutcome> {
    // Its run.start is still starting Pi: the steer goes to Pi once the prompt is there.
    const pending = this.#starting.get(frame.run_id);
    if (pending?.threadId === frame.thread_id && !pending.stopped) await pending.done;
    const thread = this.#threads.get(frame.thread_id);
    if (thread?.runId !== frame.run_id) return fail("unknown_run", "run is not active here");
    // A compaction has no turn to steer (Pi would queue the message for after it).
    if (thread.compacting) return fail("pi_rejected", "the thread is compacting");
    try {
      const response = await thread.request(
        { type: "steer", message: frame.message },
        PI_REQUEST_TIMEOUT_MS,
      );
      return response.success
        ? ok({ disposition: dispositionOf(response.data) })
        : fail("pi_rejected", response.error);
    } catch (error) {
      return piFailure(error);
    }
  }

  async stopRun(frame: RunStopFrame): Promise<CommandOutcome> {
    const thread = this.#threads.get(frame.thread_id);
    if (thread?.runId !== frame.run_id) {
      // Its run.start is still starting Pi: the start sees this and never begins the run.
      const pending = this.#starting.get(frame.run_id);
      if (pending?.threadId !== frame.thread_id) {
        return fail("unknown_run", "run is not active here");
      }
      pending.stopped = true;
      return ok({ stopped: true });
    }
    const ended = thread.runEnded();
    // A compaction has no step to finish (no turn_end ever comes): after_step aborts it too; nor
    // has a run whose prompt Pi does not have yet.
    if (frame.mode === "after_step" && !thread.compacting && !thread.runPreparing) {
      thread.onStopDue = () => void this.#abort(thread);
      thread.markStopAfterStep();
    } else {
      void this.#abort(thread);
    }
    await ended;
    return ok({ stopped: true });
  }

  /** Abort a run the server no longer leases to us, or one the outbox gave up on. */
  /** The run's current span for its model calls (KOBE-274). */
  setTraceparent(runId: string, traceparent: string | null): void {
    for (const thread of this.#threads.values()) thread.setTraceparent(runId, traceparent);
  }

  abortRun(runId: string): void {
    for (const thread of this.#threads.values()) {
      if (thread.runId === runId) void this.#abort(thread);
    }
  }

  /**
   * `thread.compact` (KOBE-213): Pi's `compact` as the compaction run. Refused while the thread has
   * any other run (Pi's compact would abort it), checked again under the thread lock; the thread is
   * busy until Pi answers. The run's model is selected before `compact` (Pi reads it first), its
   * token is held in memory and handed to kobe-models on request, and the run ends with the answer.
   */
  compact(frame: Frame<"thread.compact">): Promise<CompactReply> {
    return this.#claimed(frame.thread_id, (thread) => runCompaction(this.#port, thread, frame));
  }

  /**
   * `thread.branch_summary` (KOBE-548, CT11): the branch summary run. Shaped like `#compact`: busy
   * refused under the lock, the run's model selected first (Pi summarises with its current model),
   * the token held for kobe-models' `session_before_tree`. Then the agent arms the request and
   * sends the bare `/kobe-branch-summary` prompt; Pi answers it once the command has finished, and
   * the command has reported its outcome on the armed dialog by then.
   */
  branchSummary(frame: Frame<"thread.branch_summary">): Promise<BranchSummaryReply> {
    return this.#claimed(frame.thread_id, (thread) => runBranchSummary(this.#port, thread, frame));
  }

  piCommand(frame: Frame<"pi.command">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => runPiCommand(this.#port, thread, frame));
  }

  /**
   * `thread.context` (KOBE-470, docs/specs/context-viewer.md): the latest model call's context,
   * from what this thread's Pi recorded, else rebuilt from its session file. Read only: no Pi is
   * started and nothing is written. Refused while the session is being restored or compacted.
   */
  context(frame: Frame<"thread.context">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => readContext(this.#port, thread, frame));
  }

  restore(frame: Frame<"session.restore">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => restoreSession(this.#port, thread, frame));
  }

  /** Connection lost: partial restores are void (the server restarts from part 0). */
  async abortRestores(): Promise<void> {
    await Promise.all(
      [...this.#restores.entries()].map(async ([threadId, restore]) => {
        const thread = this.#threads.get(threadId);
        if (thread === undefined) return;
        await thread.withLock(async () => {
          if (this.#restores.get(threadId) !== restore) return;
          await restore.abort();
          this.#endRestore(thread);
        });
      }),
    );
  }

  /** After a reconnect: cancel open dialogs of threads whose runs the server did not list. */
  cancelDialogsExcept(leasedRuns: ReadonlySet<string>): void {
    for (const thread of this.#threads.values()) {
      const runId = thread.runId;
      if (runId === undefined || !leasedRuns.has(runId)) thread.cancelDialogs();
    }
  }

  /**
   * `workspace.conflict_note` (KOBE-492): conflicts the server recorded for a thread whose run is
   * active here; the run's later model calls get the note. A note for a run that is not (or no
   * longer) active is dropped: it is not told again (the server marked it told).
   */
  async conflictNote(frame: WorkspaceConflictNoteFrame): Promise<boolean> {
    const thread = this.#threads.get(frame.thread_id);
    if (thread === undefined) return false;
    return thread.noteConflicts(frame.run_id, frame.conflicts);
  }

  uiResponse(frame: Frame<"pi.ui_response">): boolean {
    return this.#threads.get(frame.thread_id)?.answerDialog(frame.response) ?? false;
  }

  /**
   * Stop accepting runs; wait for active ones up to the deadline, then close all Pi processes.
   * `drain` (the server's `shutdown`, hibernation): a run still active is aborted, so Pi settles
   * it. `terminate` (SIGTERM, KOBE-444): a run still active whose prompt is in Pi is lost, not
   * finished: Pi is stopped without an abort (so nothing settles it) and the run is returned, for
   * the agent to report it with `pi.exited` (`onLost` hears of it before its Pi stops). A run
   * still preparing is ended either way.
   */
  async shutdown(
    deadlineMs: number,
    mode: "drain" | "terminate" = "drain",
    onLost?: (run: LostRun) => void,
  ): Promise<readonly LostRun[]> {
    this.#draining = true;
    clearInterval(this.#reaper);
    this.#unsubscribeTokens?.();
    this.#unsubscribeEgress?.();
    this.#unsubscribeMcp?.();
    const active = [...this.#threads.values()].map((t) => t.runEnded());
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(active),
      new Promise((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    const lost: LostRun[] = [];
    await Promise.all(
      [...this.#threads.values()].map(async (thread) => {
        const runId = thread.runId;
        if (runId !== undefined && mode === "terminate" && !thread.runPreparing) {
          const run = { threadId: thread.id, runId };
          lost.push(run);
          // Before Pi stops: stopping it ends the run here.
          onLost?.(run);
        } else if (runId !== undefined) {
          await this.#abort(thread);
        }
        await thread.withLock(() => thread.stopProcess());
      }),
    );
    return lost;
  }

  killAll(): void {
    for (const thread of this.#threads.values()) thread.kill();
  }

  /** Close Pi processes of threads idle longer than `idleMs`; forget empty threads. */
  async reapIdle(now = Date.now()): Promise<void> {
    for (const thread of [...this.#threads.values()]) {
      if (thread.busy || now - thread.lastUsed < this.#options.idleMs) continue;
      await thread.withLock(async () => {
        // Re-checked under the lock: a command may have claimed the thread meanwhile.
        if (thread.busy || Date.now() - thread.lastUsed < this.#options.idleMs) return;
        await thread.stopProcess();
        this.#options.skills?.release(thread.id);
        if (!thread.busy && this.#threads.get(thread.id) === thread) {
          this.#threads.delete(thread.id);
        }
      });
    }
  }

  /** Run a command with the thread claimed (busy) from arrival to answer. */
  async #claimed<T>(threadId: string, fn: (thread: Thread) => Promise<T>): Promise<T> {
    const thread = this.#thread(threadId);
    const release = thread.claim();
    try {
      return await fn(thread);
    } finally {
      release();
    }
  }

  #endRestore(thread: Thread): void {
    this.#restores.delete(thread.id);
    thread.restoring = false;
  }

  #thread(threadId: string): Thread {
    let thread = this.#threads.get(threadId);
    if (thread === undefined) {
      thread = new Thread(threadId, this.#options, this.#options.hooks);
      this.#threads.set(threadId, thread);
    }
    return thread;
  }

  #sessionFile(threadId: string): string {
    return sessionFilePath(this.#options.sessionDir, threadId);
  }

  #defaultHeader(threadId: string): PiSessionHeader {
    return {
      type: "session",
      version: 3,
      id: threadId,
      timestamp: new Date().toISOString(),
      cwd: this.#options.workspaceDir,
    };
  }

  async #prepareRun(thread: Thread, frame: RunStartFrame): Promise<CommandOutcome | undefined> {
    // Re-checked under the lock: a concurrent run.start may have won the thread meanwhile.
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    // App cards the server added while Pi was not running (KOBE-440): appended with Pi stopped,
    // before the branch marker that hangs below the last one.
    const file = this.#sessionFile(thread.id);
    const cards = await missingAppCards(file, frame.app_cards ?? []);
    if (cards.length > 0) {
      await thread.stopProcess();
      await ensureSessionDir(this.#options.sessionDir, {
        shared: this.#options.identities !== undefined,
        workspaceDir: this.#options.workspaceDir,
      });
      const caught = await appendAppCards(
        file,
        cards,
        () => this.#defaultHeader(thread.id),
        this.#options.restoreMaxBytes,
        this.#options.workspaceDir,
      );
      if (!caught.ok) return fail("pi_rejected", caught.message);
    }
    if (frame.parent_entry_id !== undefined) {
      await thread.stopProcess();
      const branch = await appendBranchMarker(
        this.#sessionFile(thread.id),
        frame.parent_entry_id,
        frame.run_id,
        new Date(),
        this.#options.workspaceDir,
      );
      if (!branch.ok) return fail("pi_rejected", branch.message);
    }
    return this.#ensureProcess(thread, frame);
  }

  /** Spawn (or restart, when the run's config changed) the thread's Pi. Inside the lock. */
  async #ensureProcess(
    thread: Thread,
    frame: RunStartFrame | undefined,
    model: RunModel | null = runModelOf(frame),
  ): Promise<CommandOutcome | undefined> {
    let skillDirs: readonly string[] = [];
    if (frame !== undefined) {
      const refs = frame.config?.skill_bundles ?? [];
      // The skills come before the process: Pi is started with exactly the run's effective skills,
      // and a store that fails (hash mismatch, unsafe bundle) fails the run instead of starting
      // Pi with skills nobody vouched for.
      if (this.#options.skills === undefined && refs.length > 0)
        return fail("pi_unavailable", "skills: this sandbox cannot materialize skills");
      const unlisted = (frame.config?.skills ?? []).filter((n) => !refs.some((r) => r.name === n));
      if (unlisted.length > 0)
        return fail("pi_rejected", `skills: no bundle for ${unlisted.join(", ")}`);
      try {
        skillDirs = (await this.#options.skills?.prepare(thread.id, refs)) ?? [];
      } catch (error) {
        const message = error instanceof SkillError ? error.message : (error as Error).message;
        return fail("pi_unavailable", `skills: ${message}`);
      }
    }
    // Connector tools need the proxy wiring: a run that lists connectors never starts without them.
    if ((frame?.mcp?.servers.length ?? 0) > 0 && this.#options.mcp === undefined)
      return fail("pi_unavailable", "mcp: this sandbox has no MCP proxy access");
    const launch = buildPiLaunch({
      sessionFile: this.#sessionFile(thread.id),
      skillDirs,
      home: this.#options.home,
      modelsExtension: this.#options.models?.extension,
      policyExtension: this.#options.policyExtension,
      toolsExtension: this.#options.toolsExtension,
      execExtension: this.#options.exec === undefined ? undefined : this.#options.execExtension,
      toolsFiles: this.#options.shareFiles,
      toolsProjects: this.#options.projectTools,
      toolsSkillDrafts: this.#options.skillDraftTools,
      toolsFileEdits: this.#options.fileEditTools,
      toolsNotebooks: this.#options.notebookTools,
      toolsMemory: this.#options.memoryTools,
      ...(this.#options.extensions === undefined ? {} : { extensions: this.#options.extensions }),
      parentEnv: this.#options.parentEnv,
      config: frame?.config,
      mcp: frame?.mcp,
      model,
    });
    if (thread.hasProcess) {
      // `mcp` can arrive without `config` (an agent that lost all its connectors): still a change.
      const changed =
        (frame?.config !== undefined || frame?.mcp !== undefined) &&
        launch.key !== thread.launchKey;
      // A Pi whose policy channel closed blocks every tool call for good: start a fresh one (not
      // while it is busy — its calls are blocked anyway, and Stop must still reach it).
      const broken = !thread.policyUsable;
      if (!changed && !broken) return undefined;
      if (thread.runId !== undefined || thread.streaming) return undefined;
      await thread.stopProcess();
    }
    if (!(await this.#reserveSlot(thread))) {
      return fail("pi_unavailable", "too many threads are active in this sandbox");
    }
    try {
      await thread.spawn(launch, model);
    } catch (error) {
      return fail("pi_unavailable", `cannot start Pi: ${(error as Error).message}`);
    } finally {
      // From here on the process counts through `thread.hasProcess`.
      this.#pendingSpawns -= 1;
    }
    try {
      await thread.waitPolicyReady();
    } catch (error) {
      // Fail closed: a Pi whose kobe-policy did not load would run tools unchecked.
      await thread.stopProcess();
      return fail("pi_unavailable", `kobe-policy did not start: ${(error as Error).message}`);
    }
    const tampered = await thread.verifyRuntime();
    if (tampered !== undefined) {
      await thread.stopProcess();
      return fail("runtime_tampered", tampered);
    }
    return undefined;
  }

  /**
   * Reserve a process slot (counted synchronously with spawns in flight, so concurrent spawns cannot
   * overshoot the cap), closing least recently used idle Pi processes to make room. The caller
   * releases the reservation (`#pendingSpawns`) once its spawn finished. No global lock is held
   * while waiting for another thread's lock, so this cannot deadlock.
   */
  async #reserveSlot(thread: Thread): Promise<boolean> {
    for (;;) {
      const others = [...this.#threads.values()].filter((t) => t !== thread);
      const live = others.filter((t) => t.hasProcess).length + this.#pendingSpawns;
      if (live < this.#options.maxProcesses) {
        this.#pendingSpawns += 1;
        return true;
      }
      const idle = others
        .filter((t) => t.hasProcess && !t.busy && !this.#evicting.has(t))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) return false;
      this.#evicting.add(idle);
      try {
        await idle.withLock(async () => {
          if (idle.busy) return; // claimed meanwhile: leave it
          await idle.stopProcess();
          this.#options.skills?.release(idle.id);
        });
      } finally {
        this.#evicting.delete(idle);
      }
    }
  }

  async #checkAttachments(frame: RunStartFrame): Promise<string | undefined> {
    try {
      for (const attachment of frame.attachments ?? []) {
        await confineAttachment(this.#options.workspaceDir, attachment.path);
      }
      return undefined;
    } catch (error) {
      if (error instanceof AttachmentPathError) return error.message;
      throw error;
    }
  }

  /** The images for the prompt, or the refusal text when an attachment is not confined. */
  async #promptMedia(
    frame: RunStartFrame,
  ): Promise<Awaited<ReturnType<typeof nativeImages>> | string> {
    try {
      await this.#checkAttachments(frame).then((refusal) => {
        if (refusal !== undefined) throw new AttachmentPathError(refusal);
      });
      return await nativeImages(this.#options.workspaceDir, frame.attachments ?? []);
    } catch (error) {
      if (error instanceof AttachmentPathError) return error.message;
      throw error;
    }
  }

  /** Stop: drop Pi's steering/follow-up queue first (else abort continues it), then abort. */
  async #abort(thread: Thread): Promise<void> {
    if (!thread.beginStopping()) return;
    // Its prompt has not gone to Pi: end it now; its start sees that and never sends it.
    if (thread.runPreparing) {
      thread.endRun();
      return;
    }
    const ended = thread.runEnded();
    try {
      await thread.request({ type: "clear_queue" }, PI_REQUEST_TIMEOUT_MS).catch(() => undefined);
      // A run whose prompt was accepted settles even if Pi had not emitted agent_start yet when the
      // abort arrived; never end it early, or Pi would keep working with no run to report to.
      for (let attempt = 0; attempt < 2 && thread.runId !== undefined; attempt++) {
        const response = await thread.request({ type: "abort" }, PI_SLOW_REQUEST_TIMEOUT_MS);
        if (!response.success) throw new Error(response.error);
        await raceTimeout(ended, ABORT_SETTLE_GRACE_MS);
      }
      if (thread.runId !== undefined) throw new Error("run did not settle after abort");
    } catch (error) {
      // Pi did not abort cleanly: stop the process (ends the run; tools in its group die too).
      this.#warn(thread.id, `stopping Pi: ${(error as Error).message}`);
      await thread.withLock(() => thread.stopProcess());
    }
  }

  #stoppedBeforePrompt(thread: Thread, frame: RunStartFrame): CommandOutcome {
    this.#warn(thread.id, `run ${frame.run_id} was stopped before Pi took its prompt`);
    return stoppedBeforePrompt;
  }

  #warn(threadId: string, message: string): void {
    const hooks = this.#options.hooks;
    (hooks.warning ?? hooks.diagnostic)(threadId, message);
  }
}

/** A run that was active when its Pi was stopped on SIGTERM (KOBE-444). */
export interface LostRun {
  readonly threadId: string;
  readonly runId: string;
}

/** A run.start in progress; `stopped` once a Stop for its run arrived before the run began. */
interface PendingStart {
  readonly threadId: string;
  stopped: boolean;
  /** Settles when the start has answered (its prompt is in Pi, or it failed). */
  readonly done: Promise<void>;
}

/** A run.start whose run was stopped before its prompt went to Pi (the server ended it already). */
const stoppedBeforePrompt = fail("run_not_active", "the run was stopped before Pi took its prompt");
