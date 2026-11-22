import { initTelemetry } from "@kobe/telemetry";
import type { Logger } from "pino";
import { EvalRunner } from "../agents/eval/service.js";
import type { AppOptions } from "../app.js";
import { fireAndLog } from "../async-util.js";
import { isolationAuditor } from "../audit/isolation.js";
import type { Config } from "../config.js";
import type { ServerDeps } from "../deps.js";
import { createIsolationGate, type IsolationGate } from "../isolation/gate.js";
import { listRuntimeClasses } from "../isolation/kubernetes.js";
import { logger as rootLogger } from "../logger.js";
import type { IsolationProbe } from "../runs/seams.js";
import { quantityBytes } from "../sandbox/config.js";
import { createPgReconcileLock } from "../sandbox/reconcile-lock.js";
import { createSandboxRuntime, type SandboxRuntime } from "../sandbox/runtime.js";
import { createDeferredWaker, createSandboxLifecycle } from "../sandbox-lifecycle/index.js";
import { SkillEvalHub } from "../skills/evals/events.js";
import { SKILL_EVAL_REAPER_LOCK } from "../skills/evals/reaper.js";
import { SkillEvalRunner } from "../skills/evals/runner.js";
import { egressProxyUrl, loadSkillMirrorConfig } from "../skills/mirror/config.js";
import { SkillMirror } from "../skills/mirror/runner.js";
import { ExternalScanRunner } from "../skills/registry/external-scan.js";
import { createAttachmentStager } from "../uploads/attach.js";
import { createViewingReader } from "../workspace-files/viewing.js";
import { createWorkspaceSync, type WorkspaceSync } from "../workspace-sync/index.js";
import { checkConnectionBudget } from "./db-budget.js";
import { seedAtStart, startServerJobs } from "./jobs.js";
import type { ReclaimSettings } from "../sandbox-lifecycle/reclaim.js";
import type { SandboxSettings } from "../sandbox/config.js";
import { DRAIN_TIMEOUT_MS, processJobs, type ProcessJobsContext } from "./process-jobs.js";
import { startListeners } from "./listeners.js";
import {
  checkSealedKeysAtStart,
  createProcessDeps,
  loadProcessSettings,
  warnMissingServerSettings,
  type ProcessEnv,
  type ProcessSettings,
} from "./server-deps.js";

/** How long `stop()` waits for one job's pass in flight (under the drain timeout). */
const JOB_STOP_TIMEOUT_MS = DRAIN_TIMEOUT_MS - 2_000;

export interface StartServerOptions {
  /** The environment the per-feature settings are read from (default `process.env`). */
  readonly env?: ProcessEnv;
  readonly log?: Logger;
  /** The Kubernetes RuntimeClass listing behind the isolation gate (tests pass a fake). */
  readonly listRuntimeClasses?: typeof listRuntimeClasses;
}

export interface RunningServer {
  /** The user-facing port, listening. */
  readonly port: number;
  /** The background jobs it started, by name, in start order. */
  readonly jobs: readonly string[];
  /**
   * Stops every job and timer (in `processJobs` order), closes the listeners, then the
   * dependencies (pools, the LISTEN client, the mailer) and telemetry. Rejects when the
   * user-facing listener failed to close, or the deps or telemetry failed to close. Memoised:
   * later calls return the first call's promise.
   */
  stop(): Promise<void>;
}

/** Spec D4: the process's own isolation check; its audit is bound once the database exists. */
function isolationGate(config: Config, log: Logger, list: typeof listRuntimeClasses) {
  const audit: { record?: ReturnType<typeof isolationAuditor> } = {};
  const gate = createIsolationGate({
    runtimeClassName: config.runtimeClassName,
    listRuntimeClasses: list,
    // A transient API failure at boot is retried before the pod can turn ready (KOBE-125).
    startupAttempts: 5,
    onChange: (status) => {
      void audit.record?.(status);
      if (status.state === "verified") {
        log.info(
          { runtimeClass: status.runtimeClassName, handler: status.handler },
          "isolation verified: agents enabled",
        );
      } else if (status.state === "missing") {
        log.error({ runtimeClass: status.runtimeClassName }, `agents disabled: ${status.message}`);
      }
    },
  });
  // New runs are refused at once unless the isolation runtime is verified (sandbox creation
  // enforces it regardless through isolation.require()).
  const probe: IsolationProbe = () => {
    const { state } = gate.status();
    return state === "verified" ? "available" : state;
  };
  return { gate, probe, audit };
}

/**
 * Workspace sync (KOBE-27): /workspace ↔ S3, brokered by the server on the sandbox listener so
 * sandboxes never hold object-store credentials. Off without a bucket or when disabled.
 */
function workspaceSyncOf(
  deps: ServerDeps,
  sandbox: SandboxRuntime,
  s: ProcessSettings,
  config: Config,
  log: Logger,
): WorkspaceSync | undefined {
  const sync = sandbox.settings.workspaceSync;
  if (!s.s3 || !s.objectStore || !sync.enabled) return undefined;
  return createWorkspaceSync({
    db: deps.database.db,
    objects: s.objectStore,
    prefix: s.s3.prefix,
    limits: {
      maxFileBytes: quantityBytes(sync.maxFileSize),
      maxWorkspaceBytes: quantityBytes(sync.maxWorkspaceSize ?? sandbox.settings.workspace.size),
      maxFiles: sync.maxFiles,
    },
    teamStorageDefaultBytes: s.uploads.defaultQuotaBytes,
    ...(s.uploads.defaultMaxObjects === undefined
      ? {}
      : { teamMaxObjectsDefault: s.uploads.defaultMaxObjects }),
    paused: config.retentionPaused,
    log,
  });
}

/** Everything that uses the workspace store is bound to it once it exists. */
function bindWorkspace(deps: ServerDeps, sync: WorkspaceSync, s: ProcessSettings): void {
  // Project files are mounted into members' workspaces through the same store (KOBE-162).
  deps.projectMounts.use(sync);
  // `save_skill_draft` reads the pushed skill folder from the same store (KOBE-442).
  deps.skillDraftTool.use(sync);
  // Notebook cells and their outputs (KOBE-464) live in the same store.
  deps.notebookFiles.use(sync);
  // Message attachments (KOBE-144); without them `file_ids` are refused. A message's viewed
  // file (KOBE-462) is read from the member's synced workspace.
  deps.runWorkspace.use({
    attachments: createAttachmentStager({ db: deps.database.db, sync, settings: s.uploads }),
    viewing: createViewingReader(deps.database.db, sync),
  });
}

interface SkillServices {
  readonly evalRunner: EvalRunner | undefined;
  readonly externalScan: ExternalScanRunner | undefined;
  readonly skillMirror: SkillMirror | undefined;
  readonly skillEvalHub: SkillEvalHub | undefined;
  readonly skillEvalRunner: SkillEvalRunner | undefined;
}

const NO_SKILL_SERVICES: SkillServices = {
  evalRunner: undefined,
  externalScan: undefined,
  skillMirror: undefined,
  skillEvalHub: undefined,
  skillEvalRunner: undefined,
};

/**
 * Pre-publish Orbit evals (KOBE-93), the optional external skill scanner (KOBE-341), the git
 * mirror of the catalog (KOBE-343) and skill evals (KOBE-325): server replicas only.
 */
function skillServices(
  deps: ServerDeps | undefined,
  sandbox: SandboxRuntime | undefined,
  isolation: IsolationGate,
  mirror: ReturnType<typeof loadSkillMirrorConfig>,
  log: Logger,
): SkillServices {
  const db = deps?.database.db;
  const blobs = deps?.blobs;
  return {
    evalRunner:
      sandbox && deps
        ? new EvalRunner({
            db: deps.database.db,
            kube: sandbox.kube,
            provider: sandbox.provider,
            isolation,
            settings: sandbox.settings,
            sessionKeys: sandbox.sessionKeys,
            limits: { maxVersions: deps.agentLimits.maxVersions },
          })
        : undefined,
    externalScan:
      sandbox && db && blobs
        ? new ExternalScanRunner({
            db,
            blobs,
            kube: sandbox.kube,
            provider: sandbox.provider,
            isolation,
            settings: sandbox.settings,
          })
        : undefined,
    // Pushes through the egress proxy with a site egress token; the remote's token comes from
    // the chart's Secret.
    skillMirror:
      deps && blobs && mirror
        ? new SkillMirror({
            db: deps.database.db,
            pool: deps.database.pool,
            blobs,
            credentials: mirror.credentials,
            egress: sandbox
              ? {
                  proxyUrl: egressProxyUrl(sandbox.settings),
                  key: sandbox.sessionKeys["kobe.egress-proxy"],
                }
              : null,
            author: mirror.author,
          })
        : undefined,
    skillEvalHub: deps ? new SkillEvalHub(deps.listen) : undefined,
    skillEvalRunner:
      sandbox && deps && blobs
        ? new SkillEvalRunner({
            db: deps.database.db,
            blobs,
            router: deps.sandboxWire.router,
            runs: deps.runs,
            provider: sandbox.provider,
            maxConcurrentPerTeam: sandbox.settings.skillEval.maxConcurrentPerTeam,
            log,
            // KOBE-326: without server calls a `judge` check fails `judge_failed`.
            ...(deps.skillEvalJudge ? { judge: deps.skillEvalJudge } : {}),
          })
        : undefined,
  };
}

/** The server replica's own jobs' settings (startup/jobs.ts, KOBE-422). */
/**
 * Dormant-volume reclaim (KOBE-733): only with the chart switch on and workspace sync running (the
 * object-store copy is what the next wake restores from). The proof is the agent's shutdown
 * `POST flushed` (sandbox-lifecycle/reclaim.ts); the reaper runs in the hibernation sweep job.
 */
function reclaimSettings(
  settings: SandboxSettings,
  syncOn: boolean,
  log: { warn(msg: string): void },
): { reclaim?: ReclaimSettings } {
  const reclaim = settings.hibernation.reclaim;
  if (!reclaim.enabled) return {};
  if (!syncOn) {
    log.warn("sandbox.hibernation.reclaim is on but workspace sync is off: nothing is reclaimed");
    return {};
  }
  return { reclaim: { dormantDays: reclaim.dormantDays } };
}

function serverJobsOptions(
  config: Config,
  settings: ProcessSettings,
): NonNullable<ProcessJobsContext["serverJobs"]> {
  return {
    auditForwarding: config.auditForwarding,
    retention: {
      hourUtc: config.retentionHourUtc,
      paused: config.retentionPaused,
      uploadOrphanHours: settings.uploads.orphanHours,
      sweeps: config.retentionSweeps,
    },
    connectorRefreshSeconds: config.connectorRefreshSeconds,
    models:
      settings.models && settings.bifrostAdmin
        ? { config: settings.models, admin: settings.bifrostAdmin }
        : undefined,
  };
}

/**
 * KOBE-736: the connection budget of the configured replicas against max_connections (a warning
 * only; the chart passes the inputs). Run once the server listens, never awaited.
 */
function checkConnectionBudgetSoon(config: Config, deps: ServerDeps | undefined, log: Logger) {
  if (!deps || config.process !== "server" || !config.dbBudget) return;
  fireAndLog(
    log,
    "the postgres connection budget check",
    checkConnectionBudget(
      deps.database.pool,
      {
        serverReplicas: config.dbBudget.serverReplicas,
        poolMax: config.dbPools.max,
        streamPoolMax: config.dbPools.streamMax,
        peerConnections: config.dbBudget.peerConnections,
      },
      log,
    ),
  );
}

/** The sandbox runtime of each process (KOBE-22): the scheduler gets the provider only. */
function sandboxRuntimes(
  config: Config,
  env: ProcessEnv,
  isolation: IsolationGate,
  deps: ServerDeps | undefined,
  log: Logger,
) {
  const isServer = config.process === "server";
  const db = deps?.database.db;
  // The scheduler holds no session-token key (tokens are signed on the server's sandbox listener
  // and wire), so a compromised scheduler can't forge them.
  const sandbox = isServer ? createSandboxRuntime(env, isolation, db) : undefined;
  const providerRuntime =
    sandbox ??
    (isServer ? undefined : createSandboxRuntime(env, isolation, db, { providerOnly: true }));
  if (!providerRuntime) {
    log.error(
      "KOBE_SANDBOX_CONFIG is not set: sandboxes are disabled (install with the Helm chart)",
    );
  }
  return { sandbox, providerRuntime };
}

/**
 * The composition root (KOBE-709): builds the process (`config.process`: the API server or the
 * scheduler), starts its jobs and listeners, and returns how to stop it all again.
 */
export async function startServer(
  config: Config,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const log = options.log ?? rootLogger;
  const isServer = config.process === "server";
  const settings = loadProcessSettings(config, env, log);
  const telemetry = initTelemetry(settings.telemetry);
  // The wire is built before the sandbox provider exists: its waker is set once the provider is.
  const waker = createDeferredWaker();
  // Created before the dependencies: the run orchestrator requires its probe (KOBE-708).
  const isolation = isolationGate(config, log, options.listRuntimeClasses ?? listRuntimeClasses);
  const deps = createProcessDeps({ config, env, settings, log, isolation: isolation.probe, waker });
  // Seeds awaited before the server serves (startup/jobs.ts); a failure never stops the start.
  const startSeeds = deps && isServer ? await seedAtStart(deps, log) : undefined;
  if (deps && isServer) await checkSealedKeysAtStart(deps, settings, log);
  if (deps) isolation.audit.record = isolationAuditor(deps.database.db);
  if (isServer) warnMissingServerSettings(settings, log);
  const { sandbox, providerRuntime } = sandboxRuntimes(config, env, isolation.gate, deps, log);
  const workspaceSync =
    sandbox && deps ? workspaceSyncOf(deps, sandbox, settings, config, log) : undefined;
  if (workspaceSync && deps) bindWorkspace(deps, workspaceSync, settings);
  if (sandbox && sandbox.settings.workspaceSync.enabled && !settings.s3) {
    log.warn("object storage is not configured (s3.bucket): workspace sync is off");
  }
  const skills = isServer
    ? skillServices(deps, sandbox, isolation.gate, loadSkillMirrorConfig(env), log)
    : NO_SKILL_SERVICES;
  const kickSkillEvals = () => fireAndLog(log, "skill eval sweep", skills.skillEvalRunner?.sweep());
  // Offboarding's first pass deletes volumes, so it gets the provider before the jobs start.
  if (providerRuntime && deps) deps.offboarding.setProvider(providerRuntime.provider);
  // A workspace lost with its node is rebuilt from the last sync (KOBE-739): needs workspace sync.
  if (providerRuntime && deps) {
    deps.workspaceRebuild.setProvider(providerRuntime.provider, workspaceSync !== undefined, {
      graceMinutes: providerRuntime.settings.volumeLoss.graceMinutes,
    });
  }
  const lifecycle =
    providerRuntime && deps
      ? createSandboxLifecycle({
          db: deps.database.db,
          provider: providerRuntime.provider,
          idleMinutes: providerRuntime.settings.hibernation.idleMinutes,
          // A returning member's offboarded sandbox is replaced by a new one (KOBE-28, D12).
          reinstate: (target) => deps.offboarding.reinstate(target),
          // KOBE-739: how long a volume's node must stay down before a wake reports it lost.
          volumeLossGraceMinutes: providerRuntime.settings.volumeLoss.graceMinutes,
          ...reclaimSettings(providerRuntime.settings, workspaceSync !== undefined, log),
        })
      : undefined;
  if (lifecycle) waker.set(lifecycle.waker);
  const context: ProcessJobsContext = {
    config,
    log,
    isolation: isolation.gate,
    deps,
    serverJobs: isServer ? serverJobsOptions(config, settings) : undefined,
    startSeeds,
    sandbox,
    providerRuntime,
    lifecycle,
    workspaceSync,
    ...skills,
    kickSkillEvals,
    skillEvalReaperLock:
      skills.skillEvalRunner && deps && sandbox
        ? createPgReconcileLock(
            deps.database.pool,
            (err) => log.warn({ err }, "skill eval reaper lock connection problem"),
            SKILL_EVAL_REAPER_LOCK,
          )
        : undefined,
  };
  // A job's stop waits for its pass in flight, bounded so the deps still close before the entry
  // point's hard exit (the drain timeout + 1 s).
  const jobs = processJobs(context);
  const stopJobs = startServerJobs(jobs, log, JOB_STOP_TIMEOUT_MS);
  const app: AppOptions = {
    isolation: isolation.gate,
    hstsIncludeSubDomains: config.auth?.hstsIncludeSubDomains ?? false,
    ingressRateLimit: config.auth?.ingressRateLimit ?? "unknown",
    ...(skills.evalRunner ? { evals: skills.evalRunner } : {}),
    ...(skills.externalScan ? { externalScan: skills.externalScan } : {}),
    ...(skills.skillMirror ? { skillMirror: skills.skillMirror } : {}),
    ...(workspaceSync ? { workspaceFiles: { sync: workspaceSync, waker } } : {}),
    skillEvals: {
      ...(skills.skillEvalHub ? { hub: skills.skillEvalHub } : {}),
      ...(skills.skillEvalRunner ? { kick: kickSkillEvals } : {}),
    },
  };
  const listeners = await startListeners({ config, log, deps, sandbox, workspaceSync, app });
  checkConnectionBudgetSoon(config, deps, log);
  const stopOnce = async () => {
    const jobsStopped = stopJobs();
    const closed = listeners.close().then(
      () => undefined,
      (err: unknown) => err,
    );
    await jobsStopped;
    const err = await closed;
    if (err) log.error({ err }, "shutdown error");
    await Promise.all([deps?.close(), telemetry.shutdown()]);
    if (err) throw err;
  };
  // Memoised: SIGTERM then SIGINT (or any second caller) waits for the same shutdown.
  let stopping: Promise<void> | undefined;
  return {
    port: listeners.port,
    jobs: jobs.map((j) => j.name),
    stop: () => (stopping ??= stopOnce()),
  };
}
