import { isTerminalRunStatus, type BudgetStopCommand } from "@kaiju/protocol";
import { SYSTEM_ACTOR, sql, withTeam } from "@kaiju/db";
import { auditExpiredApprovals, expireRunApprovalsInTx } from "../../approvals/run-end.js";
import { recordAudit } from "../../audit/record.js";
import { withAppendTx } from "../../event-stream/append.js";
import { endRunInTx } from "../../sandbox-wire/run-state.js";
import { budgetStoppedEvent } from "../lifecycle.js";
import { applyTransition, isMessageRun, lockRunRow, lockThreadRow, requestStop } from "../store.js";
import type { RunCore } from "./core.js";

/**
 * D30: a budget is exhausted. Queued runs end now; active runs finish their current step (the wire
 * converts the settle into `budget_stopped`); a compaction ends at once. Returns the runs it
 * affected; throws when some could not be stopped (the caller calls again).
 */
export async function stopForBudget(
  core: RunCore,
  command: BudgetStopCommand,
): Promise<readonly string[]> {
  const teamId = command.team_id;
  const candidates = await withTeam(core.db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string; thread_id: string; owner_user_id: string }>(sql`
      SELECT r.id, r.thread_id, t.owner_user_id
        FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId}
         AND r.status IN ('queued', 'running', 'waiting_approval')
         ${command.user_id === undefined ? sql`` : sql`AND t.owner_user_id = ${command.user_id}`}
       ORDER BY r.status <> 'queued'`);
    return res.rows;
  });
  const affected: string[] = [];
  // Queued runs first, so stopping an active run never promotes one about to be stopped.
  let failures = 0;
  for (const c of candidates) {
    const outcome = await core
      .withRetry(() =>
        withAppendTx(core.db, teamId, async (tx) => {
          const thread = await lockThreadRow(tx, teamId, c.thread_id);
          const run = await lockRunRow(tx, teamId, c.id);
          if (!thread || !run || isTerminalRunStatus(run.status)) return undefined;
          if (!isMessageRun(run)) {
            // A compaction has no step to finish (KOBE-213): it ends now and Pi aborts it.
            const applied = await applyTransition(
              tx,
              thread,
              run,
              "budget_stopped",
              "budget_exhausted",
              budgetStoppedEvent(command.scope),
            );
            await requestStop(tx, teamId, run.id, "abort");
            await recordAudit(tx, {
              action: "run.budget_stopped",
              actor: SYSTEM_ACTOR,
              teamId,
              target: { runId: run.id, threadId: thread.id, scope: command.scope },
            });
            return { transition: applied.transition, active: false, abort: true };
          }
          if (run.status === "queued") {
            const applied = await applyTransition(
              tx,
              thread,
              run,
              "budget_stopped",
              "budget_exhausted",
              budgetStoppedEvent(command.scope),
            );
            return { transition: applied.transition, active: false, abort: false };
          }
          // Already budget-stopping (the sweep re-sends its stop), or the user's own Stop is
          // pending (an abort is never downgraded to after-step): nothing to add (KOBE-42 review).
          if (run.budgetStopScope !== null) return undefined;
          const pending = await tx.execute<{ stop_mode: string | null }>(sql`
            SELECT stop_mode FROM runs WHERE team_id = ${teamId} AND id = ${run.id}`);
          if (pending.rows[0]?.stop_mode === "abort") return undefined;
          // Active: finish the current step (D30). The wire converts the settle into budget_stopped.
          await tx.execute(sql`
          UPDATE runs SET budget_stop_scope = ${command.scope}
           WHERE team_id = ${teamId} AND id = ${run.id}`);
          await requestStop(tx, teamId, run.id, "after_step");
          // D30: pending approvals expire, so the waiting call is denied and the step can finish.
          const expired = await expireRunApprovalsInTx(tx, teamId, run.id, "budget_exhausted");
          const resumed =
            expired.length > 0 && run.status === "waiting_approval"
              ? (await applyTransition(tx, thread, run, "running", "approval_resolved", undefined))
                  .transition
              : undefined;
          await auditExpiredApprovals(tx, teamId, expired);
          return { transition: resumed, active: true, abort: false };
        }),
      )
      .catch((err: unknown) => {
        // Keep stopping the others; the caller learns that some could not be stopped.
        failures += 1;
        core.log.error({ err, run_id: c.id }, "budget stop failed for a run");
        return undefined;
      });
    if (!outcome) continue;
    affected.push(c.id);
    if (outcome.transition) core.emit(teamId, [outcome.transition]);
    const target = { teamId, runId: c.id, threadId: c.thread_id, ownerUserId: c.owner_user_id };
    if (outcome.abort) core.track(core.dispatch.stopThenAdvance(target));
    if (outcome.active) core.track(core.dispatch.budgetStopActive(target, command.scope));
  }
  if (failures > 0) {
    throw new Error(`budget stop: ${failures} run(s) could not be stopped; call again`);
  }
  return affected;
}

/**
 * The sandbox is gone: its active runs end `interrupted` (`sandbox_gone`) and each thread's queue
 * advances. Returns the runs it ended.
 */
export async function markSandboxLost(
  core: RunCore,
  teamId: string,
  sandboxId: string,
  onRunEnded: (event: { teamId: string; runId: string; threadId: string }) => Promise<void>,
): Promise<readonly string[]> {
  const runs = await withTeam(core.db, teamId, async (tx) => {
    const res = await tx.execute<{ run_id: string; thread_id: string }>(sql`
      SELECT l.run_id, l.thread_id FROM sandbox_run_leases l
        JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
       WHERE l.team_id = ${teamId} AND l.sandbox_id = ${sandboxId}
         AND r.status IN ('running', 'waiting_approval')`);
    return res.rows;
  });
  const ended: string[] = [];
  for (const run of runs) {
    const result = await withAppendTx(core.db, teamId, (tx) =>
      endRunInTx(tx, teamId, run.run_id, { status: "interrupted" }, "sandbox_gone"),
    );
    if (!result.ended) continue;
    ended.push(run.run_id);
    await onRunEnded({ teamId, runId: run.run_id, threadId: run.thread_id });
  }
  return ended;
}
