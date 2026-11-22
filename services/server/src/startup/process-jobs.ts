import type { Logger } from "pino";
import type { EvalRunner } from "../agents/eval/service.js";
import { fireAndLog } from "../async-util.js";
import type { Config } from "../config.js";
import type { ServerDeps } from "../deps.js";
import type { IsolationGate } from "../isolation/gate.js";
import { deliverNotificationEmails } from "../notifications/email.js";
import { createPgReconcileLock, type ReconcileLock } from "../sandbox/reconcile-lock.js";
import type { SandboxProviderRuntime, SandboxRuntime } from "../sandbox/runtime.js";
import type { TeamReconcileSummary } from "../sandbox/team-reconcile.js";
import type { SandboxLifecycle } from "../sandbox-lifecycle/index.js";
import { onScheduledRunEnded } from "../scheduler/run-hook.js";
import { SchedulerRunner } from "../scheduler/runner.js";
import type { SkillEvalHub } from "../skills/evals/events.js";
import { reapSkillEvals, SKILL_EVAL_REAPER_MS } from "../skills/evals/reaper.js";
import { LateScanner, SKILL_LATE_SCAN_LOCK, SKILL_LATE_SCAN_MS } from "../skills/late-scan.js";
import type { SkillEvalRunner } from "../skills/evals/runner.js";
import { SKILL_MIRROR_SWEEP_MS, type SkillMirror } from "../skills/mirror/runner.js";
import type { ExternalScanRunner } from "../skills/registry/external-scan.js";
import type { WorkspaceSync } from "../workspace-sync/index.js";
import { serverJobs, type ProcessJob, type ServerJobsOptions, type StartSeeds } from "./jobs.js";

/** Orbit evals and external scans whose driver died with a server are swept this often. */
export const EVAL_SWEEP_MS = 60_000;
/** Skill eval runner sweep (KOBE-325): claims queued executions within each team's cap. */
export const SKILL_EVAL_SWEEP_MS = 5_000;
/** Open streams (SSE) get this long to finish before being cut; under k8s' 30 s grace period. */
export const DRAIN_TIMEOUT_MS = 10_000;

/** What the process built at start; each job below uses its part (absent: the job is off). */
export interface ProcessJobsContext {
  readonly config: Config;
  readonly log: Logger;
  readonly isolation: IsolationGate;
  readonly deps: ServerDeps | undefined;
  /** The server replica's background jobs (startup/jobs.ts); undefined on the scheduler. */
  readonly serverJobs: Omit<ServerJobsOptions, "deps" | "logger"> | undefined;
  readonly startSeeds: StartSeeds | undefined;
  /** The server's sandbox runtime (undefined on the scheduler, which has the provider only). */
  readonly sandbox: SandboxRuntime | undefined;
  /** The sandbox provider of either process (the scheduler's runner needs one). */
  readonly providerRuntime: SandboxProviderRuntime | undefined;
  readonly lifecycle: SandboxLifecycle | undefined;
  readonly workspaceSync: WorkspaceSync | undefined;
  readonly evalRunner: EvalRunner | undefined;
  readonly externalScan: ExternalScanRunner | undefined;
  readonly skillMirror: SkillMirror | undefined;
  readonly skillEvalHub: SkillEvalHub | undefined;
  readonly skillEvalRunner: SkillEvalRunner | undefined;
  readonly kickSkillEvals: () => void;
  readonly skillEvalReaperLock: ReconcileLock | undefined;
}

const job = (name: string, start: () => () => unknown): ProcessJob => ({ name, start });

/**
 * A sweep on an interval (unref'd, so it never holds the process open); a failed pass is logged
 * as `<what> failed` (`fireAndLog`). The stop waits for the passes in flight (KOBE-709).
 */
function every(
  name: string,
  ms: number,
  log: Logger,
  what: string,
  pass: () => Promise<unknown>,
): ProcessJob {
  return job(name, () => {
    const inFlight = new Set<Promise<unknown>>();
    const timer = setInterval(() => {
      const run = pass();
      fireAndLog(log, what, run);
      const settled: Promise<unknown> = run
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => inFlight.delete(settled));
      inFlight.add(settled);
    }, ms);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await Promise.all(inFlight);
    };
  });
}

/** When the isolation gate's startup check has settled (`verified` or `missing`). */
interface IsolationSettled {
  done: Promise<unknown>;
}

function startupJobs(c: ProcessJobsContext, isolationSettled: IsolationSettled): ProcessJob[] {
  const jobs: ProcessJob[] = [
    // Spec D4: the process's own isolation check (startup + periodic re-checks).
    job("isolation", () => {
      const started = c.isolation.start();
      started.catch((err: unknown) => c.log.error({ err }, "isolation check failed"));
      isolationSettled.done = started.then(
        () => undefined,
        () => undefined,
      );
      return () => c.isolation.stop();
    }),
  ];
  // Kobe's own catalog skills seed (KOBE-317) retries until it gets through; started by
  // `seedAtStart` before the jobs, stopped with them.
  const seeds = c.startSeeds;
  if (seeds) jobs.push(job("kobe-skills-seed", () => () => seeds.stop()));
  // Workspace blobs no manifest references are collected (KOBE-27).
  const sync = c.workspaceSync;
  if (sync) {
    const everyMs = (c.sandbox?.settings.workspaceSync.collectSeconds ?? 3600) * 1000;
    jobs.push(job("workspace-collector", () => sync.startCollector(everyMs)));
  }
  return jobs;
}

/**
 * Late scans of stored versions without a finished scan (P2-35, P2-11): server replicas with an
 * object store, one at a time (advisory lock); never inside a request.
 */
function lateScanJobs(c: ProcessJobsContext): ProcessJob[] {
  const deps = c.deps;
  const blobs = deps?.blobs;
  if (!deps || !blobs || !c.serverJobs) return [];
  const scanner = new LateScanner({ db: deps.database.db, blobs, log: c.log });
  const lock = createPgReconcileLock(
    deps.database.pool,
    (err) => c.log.warn({ err }, "skill late scan lock connection problem"),
    SKILL_LATE_SCAN_LOCK,
  );
  return [
    every("skill-late-scan", SKILL_LATE_SCAN_MS, c.log, "skill late scan", () =>
      lock.runExclusive(() => scanner.pass()),
    ),
  ];
}

/** Skills: external scans (KOBE-341), the catalog mirror (KOBE-343), skill evals (KOBE-325). */
function skillJobs(c: ProcessJobsContext): ProcessJob[] {
  const jobs: ProcessJob[] = [...lateScanJobs(c)];
  const { externalScan, skillMirror, skillEvalHub, skillEvalRunner } = c;
  if (externalScan) {
    jobs.push(
      every("external-scan-sweep", EVAL_SWEEP_MS, c.log, "external skill scan sweep", () =>
        externalScan.sweep(),
      ),
    );
  }
  if (skillMirror) {
    // Kicked at start and on approvals and settings changes; swept for retries.
    jobs.push(
      job("skill-mirror-sweep", () => {
        const timer = setInterval(() => skillMirror.kick(), SKILL_MIRROR_SWEEP_MS);
        timer.unref();
        skillMirror.kick();
        return () => {
          clearInterval(timer);
          return skillMirror.idle();
        };
      }),
    );
  }
  if (skillEvalHub) {
    jobs.push(
      job("skill-eval-hub", () => {
        skillEvalHub.start();
        return () => void skillEvalHub.close();
      }),
    );
  }
  if (skillEvalRunner) {
    // Running executions go back to queued (another replica takes them), their runs stopped and
    // sandboxes deleted, before the database pool closes (review M2).
    jobs.push(
      job("skill-eval-sweep", () => {
        const timer = setInterval(c.kickSkillEvals, SKILL_EVAL_SWEEP_MS);
        timer.unref();
        return async () => {
          clearInterval(timer);
          await skillEvalRunner
            .shutdown(DRAIN_TIMEOUT_MS - 2_000)
            .catch((err: unknown) => c.log.warn({ err }, "skill eval shutdown failed"));
        };
      }),
    );
  }
  const lock = c.skillEvalReaperLock;
  const deps = c.deps;
  const provider = c.sandbox?.provider;
  if (lock && deps && provider) {
    // One replica at a time reaps what a dead replica left.
    jobs.push(
      every("skill-eval-reaper", SKILL_EVAL_REAPER_MS, c.log, "skill eval reaper", () =>
        lock.runExclusive(() =>
          reapSkillEvals({ db: deps.database.db, provider, runs: deps.runs, log: c.log }),
        ),
      ),
    );
  }
  return jobs;
}

/** Team namespaces, hibernation and the pod reconciler: server replicas with a sandbox runtime. */
function sandboxJobs(c: ProcessJobsContext): ProcessJob[] {
  const { sandbox, deps, lifecycle } = c;
  if (!sandbox) return [];
  const jobs: ProcessJob[] = [];
  if (deps) {
    // Team namespaces follow the server version (KOBE-115): reconciled at start and on an
    // interval, one replica at a time. Awake sandboxes under changed NetworkPolicies are flagged.
    jobs.push(
      job("team-reconciler", () =>
        sandbox.startTeamReconciler({
          lock: createPgReconcileLock(deps.database.pool, (err) =>
            c.log.warn({ err }, "team reconcile lock connection problem"),
          ),
          intervalMs: c.config.teamReconcileSeconds * 1000,
          onSummary: (s) => logTeamReconcile(c.log, s),
        }),
      ),
    );
  }
  // Hibernation and wake (KOBE-25, D14): every replica sweeps for idle sandboxes (the sandboxes
  // row lock keeps replicas from colliding).
  if (lifecycle && sandbox.settings.hibernation.enabled) {
    const everyMs = sandbox.settings.hibernation.sweepSeconds * 1000;
    jobs.push(job("hibernation", () => lifecycle.start(everyMs)));
  }
  // Deletes sandbox pods found outside the verified isolation runtime (startup + every minute).
  jobs.push(
    job("pod-reconciler", () =>
      sandbox.startReconciler((result) => {
        if (result.deleted.length > 0) {
          c.log.error(
            { deleted: result.deleted, reason: result.reason },
            "deleted unverified sandbox pods",
          );
        }
      }),
    ),
  );
  return jobs;
}

function logTeamReconcile(log: Logger, s: TeamReconcileSummary): void {
  const { policyChanged, ...counts } = s;
  log.info({ ...counts, policyChanged: policyChanged.length }, "team namespaces reconciled");
  if (policyChanged.length > 0) {
    log.warn(
      { namespaces: policyChanged },
      "team namespace NetworkPolicies changed: sandboxes already running there keep their pods but now run under the new rules",
    );
  }
}

/** Scheduled runs (KOBE-174, D32) and their end hook. */
function scheduleJobs(c: ProcessJobsContext, isolationSettled: IsolationSettled): ProcessJob[] {
  const deps = c.deps;
  if (!deps) return [];
  const jobs: ProcessJob[] = [];
  // Every scheduler replica ticks; each due occurrence is claimed under a row lease and a unique
  // index, so it fires exactly once. Without a sandbox provider nothing could run, so it stays off.
  if (c.config.process === "scheduler" && c.providerRuntime) {
    const runner = new SchedulerRunner({
      db: deps.database.db,
      runs: deps.runs,
      graceMs: c.config.scheduler.graceMinutes * 60_000,
    });
    jobs.push(
      // It ticks once the isolation check has settled: while it is still `checking` every run
      // is refused, so each due occurrence would only log a warning and fire a tick late.
      job("scheduler", () => {
        let stopped = false;
        const started = isolationSettled.done.then(() => {
          if (!stopped) runner.start(c.config.scheduler.tickSeconds * 1000);
        });
        return async () => {
          stopped = true;
          await started;
          await runner.stop();
        };
      }),
    );
  }
  // A scheduled run ended (KOBE-174 hook): its notification and queued email were written with
  // the end (KOBE-179); send the email now rather than at the next sweep. Never throws.
  jobs.push(
    job("scheduled-run-hook", () =>
      onScheduledRunEnded(deps.runs, (t) => {
        c.log.debug({ run_id: t.run.run_id, status: t.to }, "scheduled run ended");
        void deliverNotificationEmails(deps, t.run.team_id);
      }),
    ),
  );
  return jobs;
}

/**
 * Every background job of the process (KOBE-709), in start order; `startServerJobs` stops them in
 * the same order and waits for all before the listeners and the database close. The server
 * replica's own jobs (`serverJobs`, KOBE-422) start after the offboarding sweep has its sandbox
 * provider (`startServer` sets it first): its first pass deletes volumes.
 */
export function processJobs(c: ProcessJobsContext): ProcessJob[] {
  const evalRunner = c.evalRunner;
  // Set by the `isolation` job, which starts first.
  const isolationSettled: IsolationSettled = { done: Promise.resolve() };
  return [
    ...startupJobs(c, isolationSettled),
    ...skillJobs(c),
    ...(c.deps && c.serverJobs ? serverJobs({ ...c.serverJobs, deps: c.deps, logger: c.log }) : []),
    ...sandboxJobs(c),
    ...scheduleJobs(c, isolationSettled),
    // Orbit evals whose driver died with a server (restart mid-eval) are finished or errored.
    ...(evalRunner
      ? [
          every("orbit-eval-sweep", EVAL_SWEEP_MS, c.log, "orbit eval sweep", () =>
            evalRunner.sweep(),
          ),
        ]
      : []),
  ];
}
