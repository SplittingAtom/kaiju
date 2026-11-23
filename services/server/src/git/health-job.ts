import {
  readGitConnections,
  readGitSiteSettings,
  scanTeams,
  type Envelope,
  type GitConnectionRecord,
  type KobeDb,
} from "@kobe/db";
import type { Logger } from "pino";
import type { InstallationTokenCache } from "../git-hosts/github/app-auth.js";
import type { GitHostNet } from "../git-hosts/http.js";
import type { Mailer } from "../mail/mailer.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";
import { checkGitConnection } from "./connections.js";
import { notifyGitTokenExpiry } from "./expiry-notify.js";

/**
 * Git connection health (KOBE-760, spec §7 health, G6 expiry): a periodic pass, one replica at a
 * time (session advisory lock {@link GIT_HEALTH_LOCK}), re-probes connections not checked for
 * {@link GIT_HEALTH_RECHECK_MS} with at most {@link GIT_HEALTH_CONCURRENCY} probes at once, and
 * stores each outcome (last check, last success, error code, capabilities, token expiry). A host
 * that does not answer or rate-limits is backed off (doubling from {@link BACKOFF_MIN_MS} to
 * {@link BACKOFF_MAX_MS}, or until the host's own reset time) and its other connections wait for
 * a later pass. Then the token-expiry notices go out. Teams are listed with `scanTeams()` (reads
 * only); every credential read and health write is its own short `withTeam()` transaction, and
 * no transaction is open during a host call. Connections at **Off** and a Site with Git turned
 * off are not probed.
 */
export const GIT_HEALTH_LOCK = "kobe.git-health";
export const GIT_HEALTH_SWEEP_MS = 15 * 60_000;
export const GIT_HEALTH_RECHECK_MS = 6 * 60 * 60_000;
export const GIT_HEALTH_CONCURRENCY = 4;
const BACKOFF_MIN_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Codes that say the host (not the credential) is the problem: back off the host. */
const HOST_TROUBLE = new Set(["host_unreachable", "rate_limited", "unexpected", "conflict"]);

/** Per-host back-off, in memory (the pass runs on one replica at a time). */
export class GitHostBackoff {
  private readonly hosts = new Map<string, { until: number; delay: number }>();

  blocked(host: string, now: number): boolean {
    const b = this.hosts.get(host);
    return b !== undefined && b.until > now;
  }

  fail(host: string, now: number, resetAt?: Date): void {
    const delay = Math.min((this.hosts.get(host)?.delay ?? BACKOFF_MIN_MS / 2) * 2, BACKOFF_MAX_MS);
    const reset = resetAt ? Math.min(resetAt.getTime(), now + BACKOFF_MAX_MS) : 0;
    this.hosts.set(host, { until: Math.max(now + delay, reset), delay });
  }

  ok(host: string): void {
    this.hosts.delete(host);
  }
}

export interface GitHealthDeps {
  readonly db: KobeDb;
  readonly envelope: Envelope | undefined;
  readonly net: GitHostNet;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly tokenCache?: InstallationTokenCache;
  readonly now?: () => number;
  readonly recheckMs?: number;
  readonly concurrency?: number;
}

export interface GitHealthPass {
  readonly checked: number;
  readonly failed: number;
  /** Due but not probed: their host is backed off. */
  readonly deferred: number;
  readonly noticed: number;
}

const hostOf = (c: GitConnectionRecord) => new URL(c.baseUrl).host.toLowerCase();

async function dueConnections(db: KobeDb, before: number): Promise<GitConnectionRecord[]> {
  const perTeam = await scanTeams(db, "git health", async (tx, team) => {
    const due = (await readGitConnections(tx, team.id)).filter(
      (c) =>
        c.accessLevel !== "off" &&
        (c.lastCheckedAt === null || c.lastCheckedAt.getTime() <= before),
    );
    return due.length > 0 ? due : undefined;
  });
  // Least recently checked first, across Workspaces.
  return perTeam
    .flat()
    .sort((a, b) => (a.lastCheckedAt?.getTime() ?? 0) - (b.lastCheckedAt?.getTime() ?? 0));
}

/** One health pass (probes, then expiry notices). */
export async function runGitHealthPass(
  d: GitHealthDeps,
  backoff: GitHostBackoff = new GitHostBackoff(),
): Promise<GitHealthPass> {
  const now = d.now ?? Date.now;
  let checked = 0;
  let failed = 0;
  let deferred = 0;
  const envelope = d.envelope;
  const settings = await readGitSiteSettings(d.db);
  if (envelope && settings.enabled) {
    const queue = await dueConnections(d.db, now() - (d.recheckMs ?? GIT_HEALTH_RECHECK_MS));
    const busy = new Set<string>();
    const worker = async () => {
      for (;;) {
        // One probe per host at a time; a backed-off host's connections wait for a later pass.
        const index = queue.findIndex((c) => !busy.has(hostOf(c)));
        if (index < 0) return;
        const [c] = queue.splice(index, 1);
        if (!c) return;
        const host = hostOf(c);
        if (backoff.blocked(host, now())) {
          deferred += 1;
          continue;
        }
        busy.add(host);
        try {
          const out = await checkGitConnection(
            {
              db: d.db,
              envelope,
              net: d.net,
              ...(d.tokenCache ? { tokenCache: d.tokenCache } : {}),
            },
            settings,
            c,
          );
          if (out.kind === "checked") {
            checked += 1;
            backoff.ok(host);
          } else if (out.kind === "failed") {
            checked += 1;
            failed += 1;
            if (HOST_TROUBLE.has(out.code)) backoff.fail(host, now(), out.error?.resetAt);
          }
        } catch (err) {
          failed += 1;
          backoff.fail(host, now());
          d.logger.warn({ err, team_id: c.teamId, connection_id: c.id }, "git health check failed");
        } finally {
          busy.delete(host);
        }
      }
    };
    const workers = Math.max(1, Math.min(d.concurrency ?? GIT_HEALTH_CONCURRENCY, 16));
    await Promise.all(Array.from({ length: workers }, worker));
  }
  const noticed = await notifyGitTokenExpiry({
    db: d.db,
    mailer: d.mailer,
    publicUrl: d.publicUrl,
    logger: d.logger,
    ...(d.now ? { now: d.now } : {}),
  });
  return { checked, failed, deferred, noticed };
}

/** The periodic job: a pass at start and every {@link GIT_HEALTH_SWEEP_MS}. */
export class GitHealthJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private current: Promise<unknown> = Promise.resolve();
  private readonly backoff = new GitHostBackoff();

  constructor(
    private readonly d: GitHealthDeps,
    private readonly lock: ReconcileLock,
    private readonly everyMs = GIT_HEALTH_SWEEP_MS,
  ) {}

  async runOnce(): Promise<{ readonly ran: boolean; readonly pass?: GitHealthPass }> {
    const outcome = await this.lock.runExclusive(() => runGitHealthPass(this.d, this.backoff));
    if (!outcome.ran) return { ran: false };
    const pass = outcome.value;
    if (pass.checked + pass.noticed > 0) this.d.logger.info(pass, "git connection health pass");
    return { ran: true, pass };
  }

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.current = this.runOnce()
        .catch((err: unknown) => this.d.logger.error({ err }, "git connection health pass failed"))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer ??= setInterval(run, this.everyMs);
    this.timer.unref();
  }

  stop(): Promise<unknown> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.current;
  }
}
