import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { scanTeams, sql } from "@kaiju/db";
import { GIT_CONVERSION_SWEEP_MS, GIT_CONVERSION_WORK_PREFIX } from "./limits.js";
import { conversionWorkRoot, runConversion, type ConversionDeps } from "./runner.js";

/** Work folders older than this process belong to runs that died with an earlier one. */
const PROCESS_STARTED_AT = Date.now() - performance.now();

/**
 * The resume sweep of Convert to repo (KOBE-765): a start runs its attempt at once on the replica
 * that took the request; this finds running attempts nobody holds (the replica restarted or
 * crashed, so the lease lapsed) and runs them here, one at a time, at their recorded step. Every
 * replica sweeps; the claim (`claimConversion`) is atomic, so an attempt runs on one replica only.
 * Teams are listed with `scanTeams()` (reads only); each attempt then runs in its own team
 * transactions.
 */
export async function sweepGitConversions(deps: ConversionDeps): Promise<number> {
  await removeStaleWorkDirs(PROCESS_STARTED_AT);
  const due = (
    await scanTeams(deps.db, "git conversion sweep", async (tx, team) => {
      const res = await tx.execute<{ id: string }>(sql`
        SELECT id FROM git_conversions
         WHERE team_id = ${team.id} AND status = 'running'
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY created_at LIMIT 20`);
      return res.rows.length > 0 ? res.rows.map((r) => ({ teamId: team.id, id: r.id })) : undefined;
    })
  ).flat();
  let ran = 0;
  for (const c of due) {
    const outcome = await runConversion(deps, c.teamId, c.id);
    if (outcome !== "busy") ran += 1;
  }
  return ran;
}

/** Work directories a run left when its process died (a container restart keeps the emptyDir). */
export async function removeStaleWorkDirs(
  before: number,
  dir = conversionWorkRoot(),
): Promise<number> {
  let removed = 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(GIT_CONVERSION_WORK_PREFIX)) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isDirectory() || info.mtimeMs >= before) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

/**
 * The route's run: this attempt now (or, when this replica is busy, left for the sweep), then
 * whatever else waits, so a queued attempt starts as soon as a slot frees.
 */
export async function runThenDrain(
  deps: ConversionDeps,
  teamId: string,
  id: string,
): Promise<void> {
  const outcome = await runConversion(deps, teamId, id);
  if (outcome !== "busy") await sweepGitConversions(deps);
}

/** The periodic sweep: at start and every {@link GIT_CONVERSION_SWEEP_MS}. */
export class GitConversionSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private current: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: ConversionDeps,
    private readonly everyMs = GIT_CONVERSION_SWEEP_MS,
  ) {}

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.current = sweepGitConversions(this.deps)
        .then((ran) => {
          if (ran > 0) this.deps.log.info({ ran }, "git conversions resumed");
        })
        .catch((err: unknown) => this.deps.log.error({ err }, "git conversion sweep failed"))
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
