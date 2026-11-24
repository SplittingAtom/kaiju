import {
  SYNC_CONFLICT_NOTES_MAX,
  type RunMemoryContext,
  type RunProjectContext,
  type RunViewingContext,
  type SyncConflict,
} from "@kobe/protocol";
import {
  REPO_WORKING_COPY_DIR,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiRpcResponse,
  type RunGitContext,
  type RunGitRepo,
} from "@kobe/protocol/sandbox-wire";
import { PolicyChannel } from "../policy/channel.js";
import { ToolsChannel } from "../tools/channel.js";
import type { MemoryContextFile } from "../memory/context-file.js";
import { memoryRunFileContent, threadFenceNonce } from "../memory/context.js";
import { conflictNoteText } from "../memory/conflict-context.js";
import {
  CONFLICT_NOTE_TYPE,
  MEMORY_PICKS_TYPE,
  PICKS_NOTES_MAX,
  perMessageNote,
} from "../kobe-tools/memory-hooks.js";
import { PiProcessError, type PiExit, type PiProcess, type PiRecord } from "../pi/pi-process.js";
import type { PiLaunch } from "../pi/pi-launch.js";
import type {
  BranchSummaryOutcome,
  BranchSummaryRequest,
} from "../kobe-models/branch-summary-protocol.js";
import type { KobePromptParts } from "../context/system-prompt.js";
import type { SystemPromptFile } from "../pi/system-prompt-file.js";
import { MCP_TOKEN_FILE, mcpTokenFileText, writeAgentFile } from "../mcp/pi-mcp-config.js";
import type { ModelFile } from "../models/model-file.js";
import type { RunModel } from "../models/types.js";
import type { EgressTokenFile } from "../egress/egress-wiring.js";
import { gitConfigText, type GitConfigFile } from "../git/git-config.js";
import {
  REPO_PREPARE_TIMEOUT_MS,
  REPO_STATUS_TIMEOUT_MS,
  failedStatus,
  repoStatusFrame,
  workingCopyStatus,
  type RepoStatus,
} from "../git/working-copy.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { shareOnVolume } from "../workspace/volume.js";
import { toolCommandRunner } from "./tool-command.js";
import { BranchSummaryState } from "./branch-summary-state.js";
import { cancelDialog, routeUiRequest } from "./dialogs.js";
import { reclaimRuntime } from "./reclaim.js";
import { verifyRuntime } from "./runtime-check.js";
import { spawnPi } from "./spawn.js";
import {
  POLICY_READY_TIMEOUT_MS,
  type McpConfigState,
  type RuntimeOf,
  type ThreadEnv,
  type ThreadHooks,
} from "./thread-env.js";

interface ActiveRun {
  readonly runId: string;
  /** A compaction run (KOBE-213): Pi's `compact`, which never emits `turn_end` or settles. */
  readonly compaction: boolean;
  stopAfterStep: boolean;
  stopping: boolean;
  /** Started, its prompt not yet sent to Pi (a message run): Pi has nothing of it to abort. */
  preparing: boolean;
  readonly ended: Promise<void>;
  readonly resolveEnded: () => void;
}

/** The run file's share for earlier messages' notes (KOBE-662); a note is at most ~50 KiB. */
const PICKS_NOTES_MAX_BYTES = 4 * 1024 * 1024;

/**
 * One Kaiju thread's Pi process and its active run. All lifecycle changes (spawn, restart, stop,
 * session-file writes) are serialised through `withLock`; Pi requests run outside the lock.
 * Starting a Pi is in `spawn.ts`, the tamper check in `runtime-check.ts`, the reclaim after exit in
 * `reclaim.ts`, and extension UI routing in `dialogs.ts`.
 */
export class Thread {
  readonly id: string;
  readonly #env: ThreadEnv;
  readonly #hooks: ThreadHooks;
  #pi: PiProcess | undefined;
  #policy: PolicyChannel | undefined;
  #launchKey: string | undefined;
  /** The current Pi's model file (undefined without model wiring). */
  #modelFile: ModelFile | undefined;
  /** The active run's gateway token (KOBE-118): held in memory for this thread's Pi only. */
  #runToken: { readonly runId: string; readonly token: string } | undefined;
  /** A branch summary the agent armed for its run (KOBE-548). */
  readonly #branchSummary = new BranchSummaryState();
  /** Where the current Pi's `mcp.json` lives and what it was built from (KOBE-111). */
  #mcpConfig: McpConfigState | undefined;
  /** The current Pi's egress token file (undefined without egress wiring). */
  #egressFile: EgressTokenFile | undefined;
  /** The current Pi's git config file (KOBE-764). */
  #gitFile: GitConfigFile | undefined;
  /** The current run's Repo working copy (KOBE-767): its status is read again at the run's end. */
  #repo: { readonly runId: string; readonly repo: RunGitRepo } | undefined;
  #promptFile: SystemPromptFile | undefined;
  #memoryFile: MemoryContextFile | undefined;
  /** Where the current Pi's kobe-models records its latest model call (KOBE-470). */
  #contextFile: string | undefined;
  /** Conflicts told during the current run (KOBE-492); cleared when the next run attaches. */
  #liveConflicts: readonly SyncConflict[] = [];
  /**
   * The picks notes of this thread's messages (KOBE-662), by their user message's timestamp. Kept
   * here, not in Pi: the server restarts Pi for every message (each run's `kobe.branch` marker),
   * and a message that loses its note changes the request's prefix and the provider's cache.
   * Memory only, never in the session; oldest dropped past {@link PICKS_NOTES_MAX} notes or
   * {@link PICKS_NOTES_MAX_BYTES} (the run file carries them all before every prompt).
   */
  readonly #picksNotes = new Map<number, string>();
  /** The current run's note, until its user message shows up in Pi's events. */
  #runNote: { readonly runId: string; readonly text: string } | undefined;
  /** Each process's private runtime directory (and identity), removed once it has exited. */
  readonly #runtimeDirs = new Map<PiProcess, RuntimeOf>();
  /** Removal of a runtime directory in progress (awaited by `stopProcess`). */
  readonly #removals = new Map<PiProcess, Promise<void>>();
  #closing = new Set<PiProcess>();
  #run: ActiveRun | undefined;
  #streaming = false;
  #dialogs = new Map<string, PiExtensionUiRequest>();
  #lock: Promise<unknown> = Promise.resolve();
  #inflight = 0;
  /** Commands in progress on this thread (taken synchronously when a command arrives). */
  #claims = 0;
  lastUsed = Date.now();
  restoring = false;

  constructor(id: string, env: ThreadEnv, hooks: ThreadHooks) {
    this.id = id;
    this.#env = env;
    this.#hooks = hooks;
  }

  get runId(): string | undefined {
    return this.#run?.runId;
  }

  /** The active run is a compaction (KOBE-213). */
  get compacting(): boolean {
    return this.#run?.compaction === true;
  }

  get hasProcess(): boolean {
    return this.#pi !== undefined;
  }

  /** kobe-policy in the current Pi reported ready and its channel is still open. */
  get policyUsable(): boolean {
    return this.#policy?.ready === true && !this.#policy.closed;
  }

  get launchKey(): string | undefined {
    return this.#launchKey;
  }

  get streaming(): boolean {
    return this.#streaming;
  }

  /** Busy threads are never evicted or reaped. */
  get busy(): boolean {
    return (
      this.#run !== undefined ||
      this.#streaming ||
      this.restoring ||
      this.#inflight > 0 ||
      this.#claims > 0
    );
  }

  /**
   * Mark the thread busy for the duration of a command, from the moment it arrives, so the reaper
   * and the process cap never stop (or forget) a thread a queued command is about to use.
   */
  claim(): () => void {
    this.#claims += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#claims -= 1;
    };
  }

  get pendingDialogs(): PiExtensionUiRequest[] {
    return [...this.#dialogs.values()];
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  /**
   * Spawn Pi with `launch` (call inside the lock). `model` is the run's model when known at spawn
   * (a `run.start`); a Pi started for a `pi.command` gets none until its first run.
   */
  async spawn(launch: PiLaunch, model: RunModel | null = null): Promise<void> {
    const spawned = await spawnPi(this.#env, this.id, launch, model, {
      onEvent: (pi, event) => this.#onEvent(pi, event),
      onUiRequest: (pi, record) => this.#onUiRequest(pi, record),
      onExit: (pi, exit) => this.#onExit(pi, exit),
      diagnostic: (threadId, message) => this.#hooks.diagnostic(threadId, message),
      closing: this.#closing,
    });
    const { pi, modelFile, mcpConfig, egressFile, gitFile, promptFile, memoryFile, contextFile } =
      spawned;
    this.#runtimeDirs.set(pi, spawned.runtime);
    const control = pi.control;
    let channel: PolicyChannel | undefined;
    if (control !== undefined) {
      const opened: PolicyChannel = new PolicyChannel(control, {
        onCheck: (check) =>
          this.#hooks.policyCheck(this.id, this.#run?.runId, check, (m) => opened.reply(m)),
        onCancel: (requestId) => this.#hooks.policyCancel?.(this.id, requestId),
        onClosed: (reason) => this.#hooks.policyChannelClosed(this.id, reason),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
      channel = opened;
    }
    const toolsControl = pi.toolsControl;
    if (toolsControl !== undefined) {
      const opened: ToolsChannel = new ToolsChannel(toolsControl, {
        onRequest: (request, reply) =>
          this.#hooks.toolsRequest?.(this.id, this.#run?.runId, request, reply),
        onClosed: (reason) => this.#hooks.toolsChannelClosed?.(this.id, reason),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
      void opened;
    }
    this.#pi = pi;
    this.#policy = channel;
    this.#launchKey = launch.key;
    this.#modelFile = modelFile;
    this.#mcpConfig = mcpConfig;
    this.#egressFile = egressFile;
    this.#gitFile = gitFile;
    this.#promptFile = promptFile;
    this.#memoryFile = memoryFile;
    this.#contextFile = contextFile;
    this.lastUsed = Date.now();
    // A token rotated while this spawn was in progress reached no file (the listener runs only
    // against `#modelFile`): take the current token again now that the file is attached.
    const models = this.#env.models;
    if (modelFile !== undefined && models !== undefined) {
      try {
        await modelFile.update({ token: await models.tokens.current() });
      } catch (error) {
        // No Pi stays attached without a trustworthy model file: stop it, its dir goes with it.
        await this.stopProcess();
        throw error;
      }
    }
    // Same for the egress token (a failed write only warns: the old token is still valid a while).
    const egress = this.#env.egress;
    if (egressFile !== undefined && egress !== undefined) {
      await this.updateEgressToken(await egress.tokens.current());
    }
  }

  /**
   * A rotated mcp-proxy token (KOBE-111): the token file is rewritten atomically. Pi's header
   * command reads it whenever Pi opens a connection (mcp-proxy makes an expired session reconnect).
   */
  async updateMcpToken(token: string): Promise<void> {
    const state = this.#mcpConfig;
    if (state === undefined) return;
    try {
      const text = mcpTokenFileText(token);
      state.tokenTexts = [state.tokenTexts.at(-1) ?? text, text];
      await writeAgentFile(state.agentDir, MCP_TOKEN_FILE, text, state.shared);
    } catch (error) {
      this.#warn(`mcp config not updated: ${(error as Error).message}`);
    }
  }

  /** A rotated egress token: the next bash tool call's shell reads it (KOBE-39). */
  async updateEgressToken(token: string): Promise<void> {
    try {
      await this.#egressFile?.write(token);
    } catch (error) {
      this.#warn(`egress token file not updated: ${(error as Error).message}`);
    }
  }
  /**
   * The tripwire (KOBE-41 review): the private runtime directory may only hold what the agent
   * and Pi wrote, and the model file must be what the agent last wrote. Under Pi identities
   * (KOBE-71) no other thread can write it at all and nobody but the agent can write the model
   * file; what remains is this Pi's own tools writing its `agent/` dir (`settings.json`,
   * `models.json`, `SYSTEM.md`, which Pi 1.0.0 must be able to write into). Without identities a
   * sibling thread's tool could do the same. Either way such a Pi is stopped and its run fails
   * `runtime_tampered`. Checked once Pi is ready and again right before every prompt. Returns the
   * reason, or undefined. A detector, not a boundary: see docs/ledger/KOBE-71.md.
   */
  async verifyRuntime(): Promise<string | undefined> {
    const pi = this.#pi;
    return verifyRuntime(pi === undefined ? undefined : this.#runtimeDirs.get(pi)?.dir, {
      modelFile: () => this.#modelFile,
      egressFile: () => this.#egressFile,
      gitFile: () => this.#gitFile,
      promptFile: () => this.#promptFile,
      memoryFile: () => this.#memoryFile,
      mcpConfig: () => this.#mcpConfig,
    });
  }

  /**
   * Stop this thread's Pi for a tampered runtime found around a command that could make it use
   * planted config (audit: a warning with the reason; the caller fails the command with
   * `runtime_tampered`, which the server records).
   */
  async stopTampered(reason: string, during: string): Promise<void> {
    this.#warn(`runtime_tampered during ${during}: ${reason}; Pi stopped`);
    await this.withLock(() => this.stopProcess());
  }

  /**
   * Make `runId` the run Pi attributes its model calls to (`x-kobe-run-id`), with the run's
   * model, before the prompt is sent. The extension reads the file on Pi's `input` hook and per
   * request. `traceparent` is the run's span for those calls (KOBE-274; null: untraced), in the
   * same write so the first call carries it. No-op without model wiring.
   */
  async attachRun(
    runId: string,
    model: RunModel | null,
    runToken?: string | undefined,
    traceparent: string | null = null,
  ): Promise<void> {
    // Memory only (KOBE-118): handed to this Pi on request, never written anywhere.
    this.#runToken = runToken === undefined ? undefined : { runId, token: runToken };
    await this.#modelFile?.update({ runId, model, traceparent });
  }

  /**
   * The run's current span for Pi's model calls (KOBE-274): written to the model file while `runId`
   * is this thread's run. Never fails the run.
   */
  setTraceparent(runId: string, traceparent: string | null): void {
    if (this.#run?.runId !== runId) return;
    this.#modelFile
      ?.update({ traceparent })
      .catch((error: unknown) =>
        this.#warn(`model file not updated with the trace context: ${(error as Error).message}`),
      );
  }

  /**
   * The run's git identity and connected organizations (KOBE-764): the tools' git config is
   * rewritten before the prompt, so the next git command uses them. Without a context (an older
   * server, an eval sandbox) git keeps the safe defaults and refuses to commit without identity.
   */
  async attachGit(git: RunGitContext | undefined): Promise<void> {
    await this.#gitFile?.write(gitConfigText(git));
  }

  /**
   * The run's Repo as a git working copy (KOBE-767): cloned, re-initialised or fetched as the
   * tools, then its state reported (`repo.status`). Call after `attachGit` (the tools' git config
   * routes the clone through the egress proxy) and after the workspace pull (the folder's files
   * are in place). Never throws; waits at most {@link REPO_PREPARE_TIMEOUT_MS} and a little.
   */
  async prepareRepo(runId: string, repo: RunGitRepo | undefined): Promise<void> {
    this.#repo = repo === undefined ? undefined : { runId, repo };
    if (repo === undefined) return;
    const status = await this.#repoStatus(repo, REPO_PREPARE_TIMEOUT_MS);
    this.#hooks.repoStatus?.(repoStatusFrame(runId, this.id, repo, status));
  }

  #repoStatus(repo: RunGitRepo, timeoutMs: number): Promise<RepoStatus> {
    const pi = this.#pi;
    const tools = pi === undefined ? undefined : this.#runtimeDirs.get(pi)?.tools;
    if (tools === undefined) return Promise.resolve(failedStatus("the tools are not running"));
    return this.#reposRoot(tools).then(() =>
      workingCopyStatus(toolCommandRunner(tools), this.#env.workspaceDir, repo, {
        fetch: true,
        timeoutMs,
      }),
    );
  }

  /**
   * `.kobe/repos` made by the agent (under the shared `.kobe/`, 2770 like the sessions folder) so
   * the tools' uid can create its working copies there; never followed through a link.
   */
  async #reposRoot(tools: { readonly runAs?: unknown }): Promise<void> {
    const dir = path.join(this.#env.workspaceDir, REPO_WORKING_COPY_DIR);
    await mkdir(dir, { recursive: true, mode: 0o770 }).catch(() => undefined);
    if (tools.runAs !== undefined) {
      await shareOnVolume(this.#env.workspaceDir, dir, 0o2770).catch(() => undefined);
    }
  }

  /** At a run's end: the working copy's state once more, sent only when git gave one. */
  #reportRepoAtEnd(runId: string): void {
    const held = this.#repo;
    if (held === undefined || held.runId !== runId || this.#hooks.repoStatus === undefined) return;
    this.#repo = undefined;
    void this.#repoStatus(held.repo, REPO_STATUS_TIMEOUT_MS).then((status) => {
      if (status.head_sha === null && status.branch === null && status.problem !== null) return;
      this.#hooks.repoStatus?.(repoStatusFrame(runId, this.id, held.repo, status));
    });
  }

  /**
   * The run's memory (KOBE-157): the kobe-tools extension lists `remember` / `recall` and adds the
   * fenced index to the run's prompt only while this says so. A per-run file, not a launch input.
   */
  async attachMemory(
    memory: RunMemoryContext | undefined,
    project?: RunProjectContext,
    viewing?: RunViewingContext,
    conflicts?: readonly SyncConflict[],
    repo?: RunGitRepo,
  ): Promise<void> {
    this.#liveConflicts = [];
    // Per-thread fence nonce (KOBE-383): the memory blocks stay byte-stable across runs.
    const content = memoryRunFileContent(
      memory,
      threadFenceNonce(this.id),
      project,
      viewing,
      conflicts,
      repo,
    );
    // KOBE-662: what kobe-tools will put before this run's message, kept for later messages.
    const note =
      (content.picksPlacement ?? "system") === "system"
        ? ""
        : perMessageNote({
            picks: content.picks ?? "",
            viewing: content.viewing ?? "",
            conflicts: content.conflicts ?? "",
          });
    const runId = this.#run?.runId;
    this.#runNote = note === "" || runId === undefined ? undefined : { runId, text: note };
    await this.#memoryFile?.write({ ...content, picksNotes: [...this.#picksNotes] });
  }

  /**
   * Binds the run's note to its starting message (KOBE-662), as kobe-tools does: the first user
   * message of the run, or a custom one that is not a kobe-tools note.
   */
  #bindRunNote(runId: string, event: PiRecord): void {
    const pending = this.#runNote;
    if (pending === undefined || pending.runId !== runId || event.type !== "message_end") return;
    const message = event.message as Record<string, unknown> | undefined;
    if (typeof message !== "object" || message === null) return;
    const ts = message.timestamp;
    const own =
      message.customType === MEMORY_PICKS_TYPE || message.customType === CONFLICT_NOTE_TYPE;
    const anchor = message.role === "user" || (message.role === "custom" && !own);
    if (!anchor || typeof ts !== "number" || !Number.isFinite(ts)) return;
    this.#runNote = undefined;
    this.#picksNotes.delete(ts);
    this.#picksNotes.set(ts, pending.text);
    let bytes = 0;
    for (const text of this.#picksNotes.values()) bytes += Buffer.byteLength(text);
    while (this.#picksNotes.size > PICKS_NOTES_MAX || bytes > PICKS_NOTES_MAX_BYTES) {
      const oldest = this.#picksNotes.keys().next().value as number;
      bytes -= Buffer.byteLength(this.#picksNotes.get(oldest) ?? "");
      this.#picksNotes.delete(oldest);
    }
  }

  /**
   * Sync conflicts told while `runId` is running (KOBE-492): added to the run's memory file, so
   * kobe-tools puts them before every later model call of this run. False when the run is not
   * this thread's active one or the thread has no memory file (no kobe-tools).
   */
  async noteConflicts(runId: string, conflicts: readonly SyncConflict[]): Promise<boolean> {
    const file = this.#memoryFile;
    const written = file?.written;
    if (file === undefined || written === undefined || this.runId !== runId) return false;
    this.#liveConflicts = [...this.#liveConflicts, ...conflicts].slice(-SYNC_CONFLICT_NOTES_MAX);
    await file.write({ ...written, conflictsLive: conflictNoteText(this.#liveConflicts) ?? "" });
    return true;
  }

  /**
   * The context viewer (KOBE-470): where the running Pi's kobe-models records its latest model
   * call (undefined without a Pi or without model wiring), and the memory, project and viewed-file
   * parts the agent last wrote for its prompt (to split a forced prompt exactly).
   */
  get contextFile(): string | undefined {
    return this.#contextFile;
  }

  get promptParts(): KobePromptParts | undefined {
    const written = this.#memoryFile?.written;
    return written === undefined
      ? undefined
      : {
          memory: written.text,
          project: written.project,
          // KOBE-658: outside `system` these travel before the user message, not in the prompt.
          viewing: (written.picksPlacement ?? "system") === "system" ? (written.viewing ?? "") : "",
          conflicts:
            (written.picksPlacement ?? "system") === "system" ? (written.conflicts ?? "") : "",
          known: written.known ?? "",
          // KOBE-658: picks placed in messages are not part of the system prompt.
          picks: (written.picksPlacement ?? "system") === "system" ? (written.picks ?? "") : "",
          knownSections: written.knownSections ?? [],
          picksSections:
            (written.picksPlacement ?? "system") === "system" ? (written.picksSections ?? []) : [],
          held: written.held ?? "",
          heldSections: written.heldSections ?? [],
        };
  }

  /** A rotated model-gateway token: the next model request uses it (the current one is not cut). */
  async updateToken(token: string): Promise<void> {
    try {
      await this.#modelFile?.update({ token });
    } catch (error) {
      this.#warn(`model file not updated with the rotated token: ${(error as Error).message}`);
    }
  }

  #warn(message: string): void {
    (this.#hooks.warning ?? this.#hooks.diagnostic)(this.id, message);
  }

  /** Where the current Pi's model file is (tests and diagnostics). */
  get modelFilePath(): string | undefined {
    return this.#modelFile?.path;
  }

  /**
   * Wait until kobe-policy in the current Pi reported `channel.ready` (call inside the lock, right
   * after {@link spawn}). No prompt reaches a Pi whose policy extension did not load and self-check:
   * without it Pi would run tools unchecked.
   */
  async waitPolicyReady(): Promise<void> {
    const channel = this.#policy;
    if (channel === undefined) throw new Error("Pi has no policy channel");
    await channel.waitReady(this.#env.policyReadyTimeoutMs ?? POLICY_READY_TIMEOUT_MS);
  }

  /**
   * Stop the Pi process (call inside the lock). Ends the active run, if any, unless `keepRun`: a
   * compaction restarting Pi on its model keeps its run (KOBE-213), so the thread stays held.
   */
  async stopProcess(options: { readonly keepRun?: boolean } = {}): Promise<void> {
    const pi = this.#pi;
    if (pi === undefined) return;
    this.#closing.add(pi);
    this.#detach(pi, options.keepRun === true);
    await pi.close();
    // Its runtime directory (token, config) is gone before anything else starts.
    await this.#removals.get(pi);
  }

  /** Synchronous kill for agent exit. */
  kill(): void {
    this.#pi?.kill();
  }

  async request(command: Record<string, unknown>, timeoutMs: number): Promise<PiRpcResponse> {
    const pi = this.#pi;
    if (pi === undefined) throw new PiProcessError("Pi process is not running", "pi_unavailable");
    this.lastUsed = Date.now();
    this.#inflight += 1;
    try {
      return await pi.request(command, timeoutMs);
    } finally {
      this.#inflight -= 1;
      this.lastUsed = Date.now();
    }
  }

  beginRun(runId: string, compaction = false): void {
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    this.#run = {
      runId,
      compaction,
      stopAfterStep: false,
      stopping: false,
      preparing: false,
      ended,
      resolveEnded,
    };
    this.onStopDue = undefined;
    this.lastUsed = Date.now();
    this.#hooks.runStarted(runId, this.id);
  }

  endRun(): void {
    const run = this.#run;
    if (run === undefined) return;
    this.#run = undefined;
    this.#runToken = undefined;
    this.#branchSummary.clear();
    this.#runNote = undefined;
    this.lastUsed = Date.now();
    this.#modelFile
      ?.update({ runId: null, traceparent: null })
      .catch((error: unknown) =>
        this.#warn(`model file not updated at run end: ${(error as Error).message}`),
      );
    this.#hooks.runEnded(run.runId, this.id);
    this.#reportRepoAtEnd(run.runId);
    run.resolveEnded();
  }

  runEnded(): Promise<void> {
    return this.#run?.ended ?? Promise.resolve();
  }

  /**
   * Stop after the in-flight step: abort on the next `turn_end` (or the run settles first). Never
   * "now": Pi answers `prompt` before it emits `agent_start`, so a stop that arrives in between would
   * otherwise see an idle-looking thread and abort a step that is about to run.
   */
  markStopAfterStep(): void {
    const run = this.#run;
    if (run !== undefined) run.stopAfterStep = true;
  }

  /** The active message run is being prepared (true) or its prompt goes to Pi now (false). */
  setPreparing(preparing: boolean): void {
    const run = this.#run;
    if (run !== undefined && !run.compaction) run.preparing = preparing;
  }

  /** The active run's prompt has not gone to Pi: there is nothing in Pi to abort or settle. */
  get runPreparing(): boolean {
    return this.#run?.preparing === true;
  }

  /** Mark the run as stopping; false when a stop is already under way. */
  beginStopping(): boolean {
    const run = this.#run;
    if (run === undefined || run.stopping) return false;
    run.stopping = true;
    return true;
  }

  answerDialog(response: PiExtensionUiResponse): boolean {
    if (!this.#dialogs.delete(response.id)) return false;
    this.#pi?.send(response);
    return true;
  }

  /** Called when an abort is due after `turn_end`; set by the manager. */
  onStopDue: (() => void) | undefined;

  #onEvent(pi: PiProcess, event: PiRecord): void {
    if (pi !== this.#pi) return;
    this.lastUsed = Date.now();
    if (event.type === "agent_start") this.#streaming = true;
    const run = this.#run;
    if (run !== undefined) {
      this.#bindRunNote(run.runId, event);
      this.#hooks.piEvent(run.runId, this.id, event);
    }
    if (event.type === "turn_end" && run?.stopAfterStep === true && !run.stopping) {
      this.onStopDue?.();
    }
    if (event.type === "agent_settled") {
      this.#streaming = false;
      if (run !== undefined && this.#run === run) this.endRun();
    }
  }

  #onUiRequest(pi: PiProcess, record: PiRecord): void {
    if (pi !== this.#pi) return;
    routeUiRequest(
      {
        threadId: this.id,
        runId: this.#run?.runId,
        runToken: this.#runToken,
        branchSummary: this.#branchSummary,
        dialogs: this.#dialogs,
        hooks: this.#hooks,
      },
      pi,
      record,
    );
  }

  /**
   * Arm one branch summary for the active run (KOBE-548): the next request dialog from kobe-models
   * gets `request`, once. Without arming the command is refused (a member typed it).
   */
  armBranchSummary(runId: string, request: BranchSummaryRequest): boolean {
    if (this.#run?.runId !== runId) return false;
    this.#branchSummary.arm(runId, request);
    return true;
  }

  /** The outcome kobe-models reported for the armed summary (undefined: none came); disarms. */
  takeBranchSummary(runId: string): BranchSummaryOutcome | undefined {
    return this.#branchSummary.take(runId);
  }

  /** Cancel open dialogs (their run is no longer leased to this connection). */
  cancelDialogs(): void {
    const pi = this.#pi;
    for (const id of [...this.#dialogs.keys()]) {
      this.#dialogs.delete(id);
      if (pi !== undefined) cancelDialog(pi, id);
    }
  }
  #onExit(pi: PiProcess, exit: PiExit): void {
    const expected = this.#closing.delete(pi);
    const runId = pi === this.#pi ? this.#run?.runId : undefined;
    if (pi === this.#pi) this.#detach(pi);
    const runtime = this.#runtimeDirs.get(pi);
    this.#runtimeDirs.delete(pi);
    // The tools stop with their Pi (the executor is killed; under an identity the uid pair is
    // killed below, before the identity can go to another thread).
    runtime?.relay?.close("Pi exited");
    // The process is gone: so is its private directory (auth.json, model file, token), and under
    // a Pi identity every process of its uid, before the identity can go to another thread.
    if (runtime !== undefined) {
      const removal = this.#reclaim(runtime).finally(() => this.#removals.delete(pi));
      this.#removals.set(pi, removal);
    }
    if (!expected) this.#hooks.piExited(this.id, runId, exit);
  }

  #reclaim(runtime: RuntimeOf): Promise<void> {
    return reclaimRuntime(this.#env, runtime, (message) => this.#warn(message));
  }

  #detach(pi: PiProcess, keepRun = false): void {
    if (pi !== this.#pi) return;
    this.#pi = undefined;
    this.#policy = undefined;
    this.#launchKey = undefined;
    this.#modelFile = undefined;
    this.#mcpConfig = undefined;
    this.#egressFile = undefined;
    this.#gitFile = undefined;
    this.#promptFile = undefined;
    this.#memoryFile = undefined;
    this.#contextFile = undefined;
    this.#streaming = false;
    this.#dialogs.clear();
    if (!keepRun) this.endRun();
  }
}
