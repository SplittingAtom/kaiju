import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanTeams, sql, withTeam } from "@kobe/db";
import { fireAndLog } from "../../async-util.js";
import type { ReconcileLock } from "../../sandbox/reconcile-lock.js";
import {
  GIT_MIRROR_DIR_NAME,
  GIT_MIRROR_GONE_RECHECK_MS,
  GIT_MIRROR_INTERVAL_MS,
  GIT_MIRROR_LEASE_MS,
  GIT_MIRROR_PER_TEAM,
  GIT_MIRROR_SLOTS,
  GIT_MIRROR_SWEEP_MS,
  GIT_MIRROR_WORK_PREFIX,
} from "./limits.js";
import { refreshRepository, type MirrorDeps, type RefreshOutcome } from "./refresh.js";
import { requestMirrorRefresh } from "./store.js";

/**
 * The Repo mirror's timer (KOBE-766, G17: default every 5 minutes, no webhooks). One replica at a
 * time (session advisory lock {@link GIT_MIRROR_LOCK}) lists the Repos that are due, with
 * `scanTeams()` (reads only): linked to a project and a connection, on the host (`active` or
 * `archived`), not held by a refresh, past their back-off, and either asked for (a push, an open)
 * or not tried for {@link GIT_MIRROR_INTERVAL_MS}; a `deleted` one every
 * {@link GIT_MIRROR_GONE_RECHECK_MS}. Oldest first, at most
 * {@link GIT_MIRROR_PER_TEAM} per Workspace per pass, {@link GIT_MIRROR_SLOTS} at once. A Repo
 * whose connection was removed has nothing to check against (G20: read-only from its last mirror
 * until a Workspace admin relinks or detaches it).
 */
export const GIT_MIRROR_LOCK = "kobe.git-mirror";

/** Work folders older than this process belong to refreshes that died with an earlier one. */
const PROCESS_STARTED_AT = Date.now() - performance.now();

export interface DueRepo {
  readonly teamId: string;
  readonly id: string;
}

export async function dueRepositories(
  deps: Pick<MirrorDeps, "db">,
  intervalMs = GIT_MIRROR_INTERVAL_MS,
  goneMs = GIT_MIRROR_GONE_RECHECK_MS,
): Promise<DueRepo[]> {
  const interval = sql.raw(`interval '${Math.max(0, Math.floor(intervalMs))} milliseconds'`);
  const gone = sql.raw(`interval '${Math.max(0, Math.floor(goneMs))} milliseconds'`);
  return (
    await scanTeams(deps.db, "git mirror", async (tx, team) => {
      const res = await tx.execute<{ id: string }>(sql`
        SELECT id FROM git_repositories
         WHERE team_id = ${team.id} AND project_id IS NOT NULL AND connection_id IS NOT NULL
           AND (mirror_lease_until IS NULL OR mirror_lease_until < now())
           AND (mirror_next_at IS NULL OR mirror_next_at <= now())
           AND ((host_state IN ('active', 'archived')
                 AND (mirror_requested_at <= now() OR mirror_attempted_at IS NULL
                      OR mirror_attempted_at < now() - ${interval}))
                -- Review M2: a deleted repository is checked again slowly (access may return).
                OR (host_state = 'deleted'
                    AND (mirror_attempted_at IS NULL OR mirror_attempted_at < now() - ${gone})))
         ORDER BY mirror_attempted_at ASC NULLS FIRST
         LIMIT ${GIT_MIRROR_PER_TEAM}`);
      return res.rows.length > 0 ? res.rows.map((r) => ({ teamId: team.id, id: r.id })) : undefined;
    })
  ).flat();
}

export interface MirrorPass {
  readonly refreshed: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly other: number;
}

/** One pass: every due Repo, {@link GIT_MIRROR_SLOTS} at a time. */
export async function sweepGitMirrors(deps: MirrorDeps): Promise<MirrorPass> {
  await removeStaleWorkDirs(PROCESS_STARTED_AT);
  const queue = await dueRepositories(deps);
  const counts = { refreshed: 0, unchanged: 0, failed: 0, other: 0 };
  const tally = (o: RefreshOutcome) => {
    if (o === "refreshed") counts.refreshed += 1;
    else if (o === "unchanged") counts.unchanged += 1;
    else if (o === "failed") counts.failed += 1;
    else counts.other += 1;
  };
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      tally(await refreshRepository(deps, next.teamId, next.id));
    }
  };
  const workers = Math.max(1, deps.slots ?? GIT_MIRROR_SLOTS);
  await Promise.all(Array.from({ length: workers }, worker));
  return counts;
}

/**
 * A refresh now on this replica, without waiting (an open, Refresh, a push Kaiju made). When this
 * replica has no free slot, or another run holds the Repo, it is asked for instead so the next
 * pass takes it (review L6).
 */
export function kickMirrorRefresh(deps: MirrorDeps, teamId: string, repositoryId: string): void {
  const work = refreshRepository(deps, teamId, repositoryId).then(async (outcome) => {
    if (outcome !== "busy") return;
    await withTeam(deps.db, teamId, (tx) => requestMirrorRefresh(tx, teamId, { repositoryId }));
  });
  fireAndLog(deps.log, "git mirror refresh", work, {
    team_id: teamId,
    repository_id: repositoryId,
  });
}

/** Work folders a refresh left when its process died. */
export async function removeStaleWorkDirs(
  before: number,
  dir = path.join(tmpdir(), GIT_MIRROR_DIR_NAME),
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(GIT_MIRROR_WORK_PREFIX)) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isDirectory() || info.mtimeMs >= before) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

/** The periodic job: a pass at start and every {@link GIT_MIRROR_SWEEP_MS}, one replica at a time. */
export class GitMirrorJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private current: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: MirrorDeps,
    private readonly lock: ReconcileLock,
    private readonly everyMs = GIT_MIRROR_SWEEP_MS,
  ) {}

  async runOnce(): Promise<{ readonly ran: boolean; readonly pass?: MirrorPass }> {
    const outcome = await this.lock.runExclusive(() => sweepGitMirrors(this.deps));
    if (!outcome.ran) return { ran: false };
    const pass = outcome.value;
    if (pass.refreshed + pass.failed > 0) this.deps.log.info(pass, "git mirror pass");
    return { ran: true, pass };
  }

  start(): void {
    // Review R3-L2: every replica (not only the one holding the job lock) removes the work
    // folders a refresh left when an earlier process died: an emptyDir survives a container
    // restart. Only folders older than this process and than a lease.
    fireAndLog(
      this.deps.log,
      "git mirror stale work folder cleanup",
      removeStaleWorkDirs(Math.min(PROCESS_STARTED_AT, Date.now() - GIT_MIRROR_LEASE_MS)),
    );
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.current = this.runOnce()
        .catch((err: unknown) => this.deps.log.error({ err }, "git mirror pass failed"))
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
