import { scanTeams, sql } from "@kobe/db";
import { GIT_CONVERSION_SWEEP_MS } from "./limits.js";
import { runConversion, type ConversionDeps } from "./runner.js";

/**
 * The resume sweep of Convert to repo (KOBE-765): a start runs its attempt at once on the replica
 * that took the request; this finds running attempts nobody holds (the replica restarted or
 * crashed, so the lease lapsed) and runs them here, one at a time, at their recorded step. Every
 * replica sweeps; the claim (`claimConversion`) is atomic, so an attempt runs on one replica only.
 * Teams are listed with `scanTeams()` (reads only); each attempt then runs in its own team
 * transactions.
 */
export async function sweepGitConversions(deps: ConversionDeps): Promise<number> {
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
