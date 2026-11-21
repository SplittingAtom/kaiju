import {
  KOBE_EVENT_DROPPED_TYPE,
  type HelloAckFrame,
  type HelloFrame,
  type KobeEventDropped,
  type RunStartFrame,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
  type ThreadBranchSummaryFrame,
  type ThreadCompactFrame,
} from "@kobe/protocol/sandbox-wire";
import type { PiExit, PiRecord } from "./pi/pi-process.js";
import { PolicyBroker } from "./policy/broker.js";
import { ConflictReporter } from "./workspace/conflict-reporter.js";
import { ThreadManager } from "./threads/manager.js";
import { fail, ok, type CommandOutcome } from "./threads/outcome.js";
import { compactFailure, type CompactReply } from "./threads/compact.js";
import { branchSummaryFailure, type BranchSummaryReply } from "./threads/branch-summary.js";
import { WireClient, type FatalReason, type WireLogger } from "./wire/client.js";
import { encodeOutbound } from "./wire/encode.js";
import { Outbox } from "./wire/outbox.js";
import { TraceRecorder } from "./trace/recorder.js";
import { capabilitiesOf, helloCapabilities, type Capabilities } from "./agent/capabilities.js";
import type { AgentDeps } from "./agent/deps.js";
import {
  createToolBrokers,
  routeToolResult,
  routeToolsRequest,
  type ToolBrokers,
} from "./agent/wiring.js";

export type { AgentDeps, WorkspaceHooks } from "./agent/deps.js";

/** The final workspace push before the process exits (inside the pod's 30 s grace period). */
export const WORKSPACE_FLUSH_MS = 15_000;

const MAX_REMEMBERED_COMMANDS = 4096;
const MAX_QUEUED_EXITS = 64;
/**
 * SIGTERM (KOBE-444): how long a lost run's report waits for the server to store its frames. The
 * pod's grace period (30 s) also covers the 10 s drain and the workspace flush after it.
 */
const LOST_ACK_TIMEOUT_MS = 3000;
const LOST_ACK_POLL_MS = 20;
/** What a run lost to SIGTERM is reported as: its Pi stopped by the agent's termination. */
const TERMINATED: PiExit = { exitCode: null, signal: "SIGTERM", stderrTail: "" };
const COMMAND_FRAMES = new Set([
  "run.start",
  "run.steer",
  "run.stop",
  "pi.command",
  "session.restore",
  "eval.prepare",
  "eval.snapshot",
  "eval.read",
  "notebook.execute",
  "notebook.interrupt",
  "notebook.restart",
  "thread.context",
]);
const DRAIN_ON_FATAL_MS = 5000;

type PiExitedFrameT = Extract<SandboxToServerFrame, { type: "pi.exited" }>;

/**
 * kobe-sandbox-agent: glues the outbound wire (WireClient), per-run delivery (Outbox), the Pi
 * supervisor (ThreadManager) and the kobe-policy relay (PolicyBroker) together, implementing the
 * sandbox side of packages/protocol `sandbox-wire/connection.ts`. Its deps are in `agent/deps.ts`,
 * the capabilities it offers in `agent/capabilities.ts`, the kobe-tools brokers in `agent/wiring.ts`.
 */
export class Agent {
  readonly #deps: AgentDeps;
  readonly #outbox: Outbox;
  readonly #wire: WireClient;
  readonly #threads: ThreadManager;
  readonly #broker: PolicyBroker;
  readonly #tools: ToolBrokers;
  /** Runs whose `run.start.project.access` is `write` (KOBE-580): only they may commit. */
  readonly #projectWriteRuns = new Set<string>();
  /** Run spans relayed to the server (KOBE-274); records only runs started with a trace context. */
  readonly #traces: TraceRecorder;
  /** Sync conflict copies reported to the server (KOBE-492). */
  readonly #conflicts: ConflictReporter;
  /** Command ids seen on the current connection (ids are not portable across reconnects). */
  #seenCommands = new Set<string>();
  #queuedExits: { runId: string; frame: PiExitedFrameT }[] = [];
  #stopping = false;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    const { config, logger } = deps;
    this.#outbox = new Outbox(config.outboxMaxBytes);
    this.#traces = new TraceRecorder({
      sendText: (text) => this.#wire.sendText(text),
      onModelParent: (runId, traceparent) => this.#threads.setTraceparent(runId, traceparent),
    });
    this.#broker = new PolicyBroker({ send: (frame) => this.#wire.send(frame) });
    this.#tools = createToolBrokers(deps, {
      send: (frame) => this.#wire.send(frame),
      canCommit: (runId) => this.#projectWriteRuns.has(runId),
    });
    this.#conflicts = new ConflictReporter({
      ready: () => this.#wire.ready,
      send: (frame) => this.#wire.send(frame),
    });
    if (this.#caps().syncConflicts) {
      deps.workspace?.onConflict?.((report) => this.#conflicts.report(report));
    }
    this.#threads = new ThreadManager({
      bin: config.piBin,
      runtimeDir: config.piRuntimeDir,
      models: deps.models,
      egress: deps.egress,
      toolEnvScript: deps.toolEnvScript,
      mcp: deps.mcp,
      policyExtension: config.policyExtension,
      toolsExtension: deps.toolsExtension,
      exec: deps.exec?.wiring,
      piPrivateRoot: deps.parentEnv.TMPDIR ?? "/tmp",
      execExtension: deps.exec?.extension,
      shareFiles: this.#caps().files,
      projectTools: this.#caps().projects,
      skillDraftTools: this.#caps().skillDrafts,
      fileEditTools: this.#caps().fileEdits,
      notebookTools: this.#caps().notebookTools,
      memoryTools: this.#caps().memory,
      traceparentOf: (runId) => this.#traces.modelParentOf(runId),
      ...(deps.extensions === undefined ? {} : { extensions: deps.extensions }),
      ...(deps.policyReadyTimeoutMs === undefined
        ? {}
        : { policyReadyTimeoutMs: deps.policyReadyTimeoutMs }),
      workspaceDir: config.workspaceDir,
      sessionDir: config.sessionDir,
      home: deps.home,
      identities: deps.identities,
      parentEnv: deps.parentEnv,
      ...(deps.skills === undefined ? {} : { skills: deps.skills }),
      maxProcesses: config.maxPiProcesses,
      idleMs: config.piIdleMs,
      restoreMaxBytes: config.restoreMaxBytes,
      ...(deps.workspace === undefined
        ? {}
        : {
            beforeRun: (frame: RunStartFrame) => this.#pullWorkspace(frame),
          }),
      hooks: {
        runStarted: (runId, threadId) => {
          this.#wire.startRun(runId);
          this.#outbox.open(runId, threadId);
        },
        piEvent: (runId, threadId, event) => {
          this.#traces.onPiEvent(runId, event);
          this.#emitPiEvent(runId, threadId, event);
        },
        runEnded: (runId) => {
          this.#wire.endRun(runId); // frames of it still queued or yet to come are dropped (KOBE-483)
          this.#traces.runEnded(runId);
          this.#outbox.finish(runId);
          this.#broker.failRun(runId, "run ended");
          this.#tools.artifacts.failRun(runId, "run ended");
          this.#tools.shares.failRun(runId, "run ended");
          this.#tools.commits.failRun(runId, "run ended");
          this.#projectWriteRuns.delete(runId);
          this.#tools.skillDrafts.failRun(runId, "run ended");
          this.#tools.fileEdits.failRun(runId, "run ended");
          this.#tools.fileOpens.failRun(runId, "run ended");
          this.#tools.notebooks.failRun(runId, "run ended");
          deps.kernels?.runEnded(runId);
          this.#tools.memory.failRun(runId, "run ended");
          deps.workspace?.runEnded();
        },
        uiRequest: (threadId, runId, request) => {
          this.#wire.send({
            v: 1,
            type: "pi.ui_request",
            thread_id: threadId,
            ...(runId === undefined ? {} : { run_id: runId }),
            request,
          });
        },
        piExited: (threadId, runId, exit) => {
          if (runId !== undefined) this.#traces.piExited(runId);
          this.#reportExit(threadId, runId, exit);
        },
        policyCheck: (threadId, runId, check, reply) =>
          this.#broker.check(threadId, runId, check, reply),
        policyCancel: (threadId, requestId) => {
          this.#broker.cancel(threadId, requestId);
        },
        policyChannelClosed: (threadId, reason) => {
          logger.debug({ thread_id: threadId, reason }, "policy channel closed");
          this.#broker.failThread(threadId, reason);
        },
        toolsRequest: (threadId, runId, request, reply) =>
          routeToolsRequest(this.#tools, this.#caps(), threadId, runId, request, reply),
        toolsChannelClosed: (threadId, reason) => {
          logger.debug({ thread_id: threadId, reason }, "tools channel closed");
          this.#tools.artifacts.failThread(threadId, reason);
          this.#tools.shares.failThread(threadId, reason);
          this.#tools.commits.failThread(threadId, reason);
          this.#tools.skillDrafts.failThread(threadId, reason);
          this.#tools.fileEdits.failThread(threadId, reason);
          this.#tools.fileOpens.failThread(threadId, reason);
          this.#tools.notebooks.failThread(threadId, reason);
          this.#tools.memory.failThread(threadId, reason);
        },
        diagnostic: (threadId, message) => logger.debug({ thread_id: threadId }, message),
        warning: (threadId, message) => logger.warn({ thread_id: threadId }, message),
      },
    });
    this.#wire = new WireClient({
      url: config.connectUrl,
      readToken: deps.readToken,
      ...(deps.onTokenRejected === undefined ? {} : { onTokenRejected: deps.onTokenRejected }),
      hello: () => this.#hello(),
      onReady: (ack) => this.#onReady(ack),
      onFrame: (frame) => this.#onFrame(frame),
      onDisconnected: () => {
        this.#broker.failAll("connection to Kobe server lost");
        this.#tools.artifacts.failAll("connection to Kobe server lost");
        this.#tools.shares.failAll("connection to Kobe server lost");
        this.#tools.commits.failAll("connection to Kobe server lost");
        this.#tools.skillDrafts.failAll("connection to Kobe server lost");
        this.#tools.fileEdits.failAll("connection to Kobe server lost");
        this.#tools.fileOpens.failAll("connection to Kobe server lost");
        this.#tools.notebooks.failAll("connection to Kobe server lost");
        this.#tools.memory.failAll("connection to Kobe server lost");
        void this.#threads.abortRestores();
      },
      onFatal: (reason) => void this.#onFatal(reason),
      logger,
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
      ...(deps.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: deps.heartbeatTimeoutMs }),
      ...(deps.pace === undefined ? {} : { pace: deps.pace }),
    });
  }

  start(): void {
    this.#wire.start();
  }

  /** Graceful stop: drain runs up to `deadlineMs`, close Pi processes, close the socket. */
  async stop(deadlineMs: number, code = 0): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#threads.shutdown(deadlineMs);
    await this.#finishStop(code);
  }

  /**
   * SIGTERM (the pod is going away, KOBE-444): drain runs up to `deadlineMs`; runs still active
   * then are lost, not finished. Their Pi is stopped without an abort, and once the server has
   * stored every frame of theirs already sent (bounded by `lostAckTimeoutMs`) each is reported
   * with `pi.exited`, so the server interrupts it (D14) instead of ending it completed or failed.
   */
  async terminate(deadlineMs: number): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const lost = await this.#threads.shutdown(deadlineMs, "terminate", (run) =>
      this.#traces.piExited(run.runId),
    );
    if (lost.length > 0) {
      await this.#untilStored(lost.map((r) => r.runId));
      for (const run of lost) {
        this.#deps.logger.warn(
          { thread_id: run.threadId, run_id: run.runId },
          "run lost: the sandbox is terminating",
        );
        this.#reportExit(run.threadId, run.runId, TERMINATED);
      }
    }
    await this.#finishStop(0);
  }

  /** Waits until the server acked every frame of these runs (the outbox forgets them), bounded. */
  async #untilStored(runIds: readonly string[]): Promise<void> {
    const end = Date.now() + (this.#deps.lostAckTimeoutMs ?? LOST_ACK_TIMEOUT_MS);
    while (runIds.some((id) => this.#outbox.has(id))) {
      if (Date.now() >= end) {
        this.#deps.logger.warn(
          { run_ids: runIds.filter((id) => this.#outbox.has(id)) },
          "lost runs reported with frames the server has not stored",
        );
        return;
      }
      await new Promise((r) => setTimeout(r, LOST_ACK_POLL_MS));
    }
  }

  async #finishStop(code: number): Promise<void> {
    // Kernels never outlive the agent (NB2): they stop before the last workspace push.
    await this.#deps.kernels?.stopAll();
    // Pi is gone, so the workspace is settled: push what changed since the last sync.
    await this.#deps.workspace?.flush(WORKSPACE_FLUSH_MS);
    this.#traces.flush();
    this.#traces.close();
    await this.#wire.stop(1000, "agent stopping");
    this.#deps.onExit(code);
  }

  /** Per-run delivery cursors (diagnostics and tests). */
  deliveryState(): { run_id: string; last_seq: number; acked_seq: number }[] {
    return this.#outbox.runIds().map((runId) => {
      const run = this.#outbox.get(runId);
      return { run_id: runId, last_seq: run?.lastSeq ?? 0, acked_seq: run?.ackedSeq ?? 0 };
    });
  }

  /** Synchronous last resort on process exit: no Pi process group outlives the agent. */
  killAll(): void {
    this.#threads.killAll();
  }

  /**
   * `workspace.sync_now` (KOBE-599): push now, then answer `workspace.synced` with the same id.
   * An answer that cannot be sent (the connection dropped) is lost; the server's wait is bounded.
   */
  #syncNow(requestId: string): void {
    const hooks = this.#deps.workspace;
    const pushed = hooks?.syncNow ? hooks.syncNow() : Promise.resolve(false);
    void pushed.then((ok) => {
      this.#wire.send({ v: 1, type: "workspace.synced", request_id: requestId, ok });
    });
  }

  /** The optional tools and features this agent offers (`agent/capabilities.ts`). */
  #caps(): Capabilities {
    return capabilitiesOf(this.#deps);
  }

  #hello(): HelloFrame {
    const capabilities = helloCapabilities(this.#deps);
    return {
      v: 1,
      type: "hello",
      sandbox_id: this.#deps.config.sandboxId,
      agent_version: this.#deps.agentVersion,
      pi_version: this.#deps.piVersion,
      runs: this.#outbox.helloRuns(),
      // Optional features, so the server sends their fields only to agents that can use them.
      ...(capabilities.length === 0 ? {} : { capabilities }),
    };
  }

  #onReady(ack: HelloAckFrame): void {
    this.#seenCommands = new Set();
    this.#outbox.resetConnectionState();
    const listed = new Map(ack.runs.map((run) => [run.run_id, run]));
    // Spans of runs the server no longer lists would name runs this connection never held.
    this.#traces.keepOnly(new Set(listed.keys()));
    for (const runId of this.#outbox.runIds()) {
      const run = listed.get(runId);
      if (run === undefined) {
        // The server no longer leases this run to us (connection.ts): abort and forget it. Nothing
        // of it may go out on this connection, not even what Pi emits while aborting (KOBE-483).
        this.#wire.endRun(runId);
        this.#threads.abortRun(runId);
        this.#outbox.drop(runId);
        continue;
      }
      if (!this.#outbox.canResendFrom(runId, run.durable_seq + 1)) {
        this.#abandonRun(runId); // the server lost frames we already dropped as acked
        continue;
      }
      if (run.durable_seq > 0) this.#outbox.ack(runId, run.durable_seq);
      for (const text of this.#outbox.resend(runId, run.durable_seq + 1)) this.#wire.sendText(text);
    }
    // Only threads leased on this connection (through a listed run) may be named: anything else
    // would be a lease violation and get the connection closed, again and again.
    const exits = this.#queuedExits;
    this.#queuedExits = [];
    for (const { runId, frame } of exits) if (listed.has(runId)) this.#wire.send(frame);
    this.#conflicts.flush();
    this.#threads.cancelDialogsExcept(new Set(listed.keys()));
    for (const dialog of this.#threads.pendingDialogs()) {
      this.#deps.logger.debug({ thread_id: dialog.threadId }, "re-sending pending UI request");
      this.#wire.send({
        v: 1,
        type: "pi.ui_request",
        thread_id: dialog.threadId,
        ...(dialog.runId === undefined ? {} : { run_id: dialog.runId }),
        request: dialog.request,
      });
    }
  }

  #onFrame(frame: ServerToSandboxFrame): void {
    if (COMMAND_FRAMES.has(frame.type)) {
      void this.#runCommand(frame);
      return;
    }
    if (frame.type === "thread.compact") {
      void this.#runCompact(frame);
      return;
    }
    if (frame.type === "thread.branch_summary") {
      void this.#runBranchSummary(frame);
      return;
    }
    if (routeToolResult(this.#tools, frame)) return;
    switch (frame.type) {
      case "pi.ui_response":
        this.#threads.uiResponse(frame);
        return;
      case "policy.pending":
        this.#broker.onPending(frame);
        return;
      case "policy.result":
        this.#traces.noteDecision(frame.run_id, frame.tool_call_id, frame.decision);
        this.#broker.onResult(frame);
        return;
      case "web_search.result":
        // Retired (KOBE-606): this agent never sends `web_search.query`, so nothing waits for it.
        return;
      case "ack":
        this.#outbox.ack(frame.run_id, frame.seq);
        return;
      case "resend":
        if (!this.#outbox.canResendFrom(frame.run_id, frame.from_seq)) {
          if (this.#outbox.has(frame.run_id)) this.#abandonRun(frame.run_id);
          return;
        }
        for (const text of this.#outbox.resend(frame.run_id, frame.from_seq)) {
          this.#wire.sendText(text);
        }
        return;
      case "workspace.moved":
        this.#deps.workspace?.movedOnServer?.();
        return;
      case "workspace.sync_now":
        this.#syncNow(frame.request_id);
        return;
      case "workspace.conflict_note":
        void this.#threads.conflictNote(frame).then((told) => {
          if (!told)
            this.#deps.logger.info({ run_id: frame.run_id }, "conflict note not delivered");
        });
        return;
      case "shutdown":
        this.#deps.logger.info({ reason: frame.reason }, "server requested shutdown");
        void this.stop(frame.deadline_ms, 0);
        return;
      case "error":
        this.#deps.logger.warn({ code: frame.code, ref: frame.ref }, "server reported an error");
        return;
      default:
        return;
    }
  }

  async #runCommand(frame: ServerToSandboxFrame): Promise<void> {
    if (!("command_id" in frame)) return;
    const commandId = frame.command_id;
    if (this.#seenCommands.has(commandId)) return;
    this.#remember(commandId);
    // Command ids are per connection (connection.ts leasing): a result for a command that arrived
    // on an earlier connection must not be sent on a later one; the server re-issues instead.
    const epoch = this.#wire.epoch;
    if (frame.type === "run.start") {
      this.#traces.startRun(frame.run_id, frame.thread_id, frame.trace);
      if (frame.project?.access === "write") this.#projectWriteRuns.add(frame.run_id);
    }
    if (frame.type === "run.stop") this.#traces.stopRequested(frame.run_id);
    let outcome: CommandOutcome;
    try {
      outcome = await this.#execute(frame);
    } catch (error) {
      this.#deps.logger.warn({ err: (error as Error).message, type: frame.type }, "command failed");
      outcome = fail("internal", "command failed in the sandbox agent");
    }
    if (!outcome.ok) logRefusal(this.#deps.logger, frame, outcome);
    if (frame.type === "run.start" && !outcome.ok) {
      this.#traces.runEnded(frame.run_id);
      this.#projectWriteRuns.delete(frame.run_id);
    }
    if (this.#wire.epoch !== epoch || !this.#wire.ready) {
      this.#deps.logger.debug({ command_id: commandId }, "result dropped: connection changed");
      return;
    }
    this.#sendResult(frame, commandId, outcome);
  }

  #execute(frame: ServerToSandboxFrame): Promise<CommandOutcome> {
    switch (frame.type) {
      case "run.start":
        return this.#threads.startRun(frame);
      case "run.steer":
        return this.#threads.steerRun(frame);
      case "run.stop":
        return this.#threads.stopRun(frame);
      case "pi.command":
        return this.#threads.piCommand(frame);
      case "session.restore":
        return this.#threads.restore(frame);
      case "eval.prepare":
      case "eval.snapshot":
      case "eval.read":
        return this.#skillEval(frame);
      case "notebook.execute":
      case "notebook.interrupt":
      case "notebook.restart":
        return this.#kernelCommand(frame);
      case "thread.context":
        return this.#threads.context(frame);
      default:
        return Promise.resolve(fail("internal", "not a command"));
    }
  }

  /**
   * KOBE-325: a skill eval's fixtures in (`eval.prepare`) or its workspace snapshot out; KOBE-326:
   * the matched outputs' bytes for the server's judge (`eval.read`).
   */
  async #skillEval(
    frame: Extract<ServerToSandboxFrame, { type: "eval.prepare" | "eval.snapshot" | "eval.read" }>,
  ): Promise<CommandOutcome> {
    const hooks = this.#deps.skillEval;
    if (!hooks) return fail("unknown_type", "this agent takes no skill eval commands");
    try {
      if (frame.type === "eval.prepare") {
        await hooks.prepare(frame);
        return ok();
      }
      if (frame.type === "eval.read") return ok(await hooks.read(frame));
      return ok(await hooks.snapshot(frame));
    } catch (error) {
      this.#deps.logger.warn(
        { err: (error as Error).message, type: frame.type },
        "eval command failed",
      );
      return fail("internal", `${frame.type} failed: ${(error as Error).message}`);
    }
  }

  /**
   * The thread kernel's commands (KOBE-464). Outputs go out as `notebook.output` frames naming the
   * command, on the connection it arrived on only (a later connection never knew that id).
   */
  async #kernelCommand(
    frame: Extract<
      ServerToSandboxFrame,
      { type: "notebook.execute" | "notebook.interrupt" | "notebook.restart" }
    >,
  ): Promise<CommandOutcome> {
    const kernels = this.#deps.kernels;
    if (kernels === undefined) return fail("unknown_type", "this agent runs no kernels");
    if (frame.type === "notebook.interrupt") return kernels.interrupt(frame.thread_id);
    if (frame.type === "notebook.restart") {
      // KOBE-477: `op: "start"` starts the kernel (nothing runs); otherwise it is a restart.
      return frame.op === "start"
        ? kernels.start(frame.thread_id)
        : kernels.restart(frame.thread_id);
    }
    const epoch = this.#wire.epoch;
    return kernels.execute(frame, (index, output) => {
      if (this.#wire.epoch !== epoch) return;
      this.#wire.send({
        v: 1,
        type: "notebook.output",
        command_id: frame.command_id,
        thread_id: frame.thread_id,
        index,
        output,
      });
    });
  }

  /**
   * `thread.compact` (KOBE-213), answered by exactly one `thread.compact_result` on the connection
   * it arrived on. Pi's error text goes to the server for its log only (it is never shown).
   */
  async #runCompact(frame: ThreadCompactFrame): Promise<void> {
    const commandId = frame.command_id;
    if (this.#seenCommands.has(commandId)) return;
    this.#remember(commandId);
    const epoch = this.#wire.epoch;
    this.#traces.startRun(frame.run_id, frame.thread_id, frame.trace, true);
    let reply: CompactReply;
    try {
      reply = await this.#threads.compact(frame);
    } catch (error) {
      this.#deps.logger.warn({ err: (error as Error).message }, "compaction failed");
      reply = compactFailure("internal", "compaction failed in the sandbox agent");
    }
    if (!reply.ok) {
      this.#deps.logger.info(
        { thread_id: frame.thread_id, run_id: frame.run_id, code: reply.error.code },
        "compaction refused",
      );
    }
    this.#traces.runEnded(frame.run_id);
    if (this.#wire.epoch !== epoch || !this.#wire.ready) return;
    const base = { v: 1, type: "thread.compact_result", command_id: commandId } as const;
    if (this.#wire.send({ ...base, thread_id: frame.thread_id, ...reply })) return;
    this.#wire.send({
      ...base,
      thread_id: frame.thread_id,
      ok: false,
      error: { code: "internal", message: "the compaction result could not be sent" },
    });
  }

  /**
   * `thread.branch_summary` (KOBE-548), answered by exactly one `thread.branch_summary_result` on
   * the connection it arrived on. Pi's text stays in this agent's log; the wire carries codes.
   */
  async #runBranchSummary(frame: ThreadBranchSummaryFrame): Promise<void> {
    const commandId = frame.command_id;
    if (this.#seenCommands.has(commandId)) return;
    this.#remember(commandId);
    const epoch = this.#wire.epoch;
    this.#traces.startRun(frame.run_id, frame.thread_id, frame.trace, true);
    let reply: BranchSummaryReply;
    try {
      reply = await this.#threads.branchSummary(frame);
    } catch (error) {
      this.#deps.logger.warn({ err: (error as Error).message }, "branch summary failed");
      reply = branchSummaryFailure("internal");
    }
    if (!reply.ok) {
      this.#deps.logger.info(
        { thread_id: frame.thread_id, run_id: frame.run_id, code: reply.error.code },
        "branch summary refused",
      );
    }
    this.#traces.runEnded(frame.run_id);
    if (this.#wire.epoch !== epoch || !this.#wire.ready) return;
    const base = { v: 1, type: "thread.branch_summary_result", command_id: commandId } as const;
    if (this.#wire.send({ ...base, thread_id: frame.thread_id, ...reply })) return;
    this.#wire.send({
      ...base,
      thread_id: frame.thread_id,
      ...branchSummaryFailure("internal"),
    });
  }

  #sendResult(frame: ServerToSandboxFrame, commandId: string, outcome: CommandOutcome): void {
    const sent = outcome.ok
      ? this.#wire.send({
          v: 1,
          type: "command.result",
          command_id: commandId,
          ok: true,
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
        })
      : false;
    if (sent) return;
    const failure = outcome.ok
      ? fail("frame_too_large", "result does not fit in one frame")
      : outcome;
    if (failure.ok) return;
    if (outcome.ok) logRefusal(this.#deps.logger, frame, failure);
    this.#wire.send({
      v: 1,
      type: "command.result",
      command_id: commandId,
      ok: false,
      error: { code: failure.code, message: failure.message },
    });
  }

  #remember(commandId: string): void {
    this.#seenCommands.add(commandId);
    if (this.#seenCommands.size > MAX_REMEMBERED_COMMANDS) {
      const oldest = this.#seenCommands.values().next().value;
      if (oldest !== undefined) this.#seenCommands.delete(oldest);
    }
  }

  /** Workspace restore before a run (KOBE-27), timed as the run's sync span (KOBE-274). */
  async #pullWorkspace(frame: RunStartFrame): Promise<void> {
    const startMs = Date.now();
    let ok = false;
    try {
      await this.#deps.workspace?.beforeRun(frame);
      ok = true;
    } finally {
      if (this.#deps.workspace !== undefined) {
        this.#traces.workspaceSync(frame.run_id, { direction: "pull", startMs, ok });
      }
    }
  }

  #emitPiEvent(runId: string, threadId: string, event: PiRecord): void {
    const appended = this.#outbox.append(runId, (seq) =>
      encodePiEvent(runId, threadId, seq, event),
    );
    if (!appended.ok) {
      if (appended.reason === "overflow") this.#abandonRun(runId);
      return;
    }
    this.#wire.sendText(appended.text);
  }

  /**
   * The un-acked buffer is full: give the run up. Abort it in Pi, forget its frames and reconnect,
   * so `hello` no longer lists it and the server interrupts it (D14).
   */
  #abandonRun(runId: string): void {
    this.#deps.logger.warn({ run_id: runId }, "run cannot be delivered; abandoning it");
    this.#wire.endRun(runId);
    this.#threads.abortRun(runId);
    this.#outbox.drop(runId);
    this.#wire.reconnect();
  }

  #reportExit(threadId: string, runId: string | undefined, exit: PiExit): void {
    const frame: PiExitedFrameT = {
      v: 1,
      type: "pi.exited",
      thread_id: threadId,
      exit_code: exit.exitCode,
      signal: exit.signal,
      stderr_tail: exit.stderrTail,
    };
    this.#deps.logger.warn({ thread_id: threadId, code: exit.exitCode }, "Pi process exited");
    // Without an active run the thread is not leased to us: the server learns nothing it needs.
    if (runId === undefined) return;
    if (this.#wire.send(frame)) return;
    if (this.#queuedExits.length < MAX_QUEUED_EXITS) this.#queuedExits.push({ runId, frame });
  }

  async #onFatal(reason: FatalReason): Promise<void> {
    this.#deps.logger.warn({ reason }, "server closed the sandbox wire for good");
    await this.stop(DRAIN_ON_FATAL_MS, reason === "unsupported_version" ? 1 : 0);
  }
}

/**
 * Build one `pi.event` frame. An event the server's decoder would reject (too large, too deep) is
 * replaced by a `kobe.event_dropped` record (`kobeEventDroppedSchema` in @kobe/protocol: not a Pi
 * type, so the server accepts it without translating it), so the seq stays gapless and the run
 * keeps going.
 */
export function encodePiEvent(
  runId: string,
  threadId: string,
  seq: number,
  event: PiRecord,
): string {
  const frame = {
    v: 1 as const,
    type: "pi.event" as const,
    run_id: runId,
    thread_id: threadId,
    seq,
  };
  const encoded = encodeOutbound({ ...frame, event });
  if (encoded.ok) return encoded.text;
  const placeholder = encodeOutbound({
    ...frame,
    event: {
      type: KOBE_EVENT_DROPPED_TYPE,
      original_type: event.type.slice(0, 64),
      reason: encoded.code,
    } satisfies KobeEventDropped,
  });
  if (!placeholder.ok) throw new Error("cannot encode placeholder pi.event");
  return placeholder.text;
}

/**
 * A refused command, with Pi's own text (KOBE-258: a refused `get_entries` once lost a run's
 * entries and nothing said why). The server never shows that text to users; the log keeps it.
 */
function logRefusal(
  logger: WireLogger,
  frame: ServerToSandboxFrame,
  outcome: Extract<CommandOutcome, { ok: false }>,
): void {
  logger.info(
    {
      type: frame.type,
      ...("thread_id" in frame ? { thread_id: frame.thread_id } : {}),
      ...("run_id" in frame ? { run_id: frame.run_id } : {}),
      ...(frame.type === "pi.command" ? { command: frame.command.type } : {}),
      code: outcome.code,
      error: outcome.message.slice(0, 500),
    },
    "command refused",
  );
}
