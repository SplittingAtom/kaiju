import { storedVerdict } from "@kobe/skill-scanner";
import {
  SYSTEM_ACTOR,
  and,
  eq,
  personalSkillScans,
  teamSkillReviews,
  withTeam,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { isStale, type ReviewKey, type RowContext, type Tally } from "./rescan-rows.js";

/**
 * Rescans that don't finish (KOBE-781 review). Each row keeps the time of its first unfinished
 * rescan under the current rule set (`rescan_incomplete_since` with `rescan_incomplete_rule_set`;
 * a newer rule set starts the clock again, a finished rescan clears it). Once a row has kept not
 * finishing for the configured period (`incompleteSuspendAfterMs`, 0: never), a version that is
 * in use is suspended as a Block would be (omitted from runs, audited, its people told) with
 * `suspended_reason = rescan_incomplete`; only a suspension with that stored reason is lifted by
 * a later finished rescan that doesn't block. The row stays under its old rule set: it is retried.
 */
const REASON = "rescan_incomplete" as const;

interface Clock {
  readonly ruleSet: number | null;
  readonly rescanIncompleteSince: Date | null;
  readonly rescanIncompleteRuleSet: number | null;
}

/**
 * What to do with a row whose rescan didn't finish now: start its clock (first time under this
 * rule set), suspend it (the period is over), or nothing (still within the period).
 */
function decide(ctx: RowContext, cur: Clock): "start" | "suspend" | "wait" | null {
  if (!isStale(cur.ruleSet, ctx.ruleSet)) return null;
  if (cur.rescanIncompleteSince === null || cur.rescanIncompleteRuleSet !== ctx.ruleSet)
    return "start";
  if (ctx.incompleteSuspendAfterMs <= 0) return "wait";
  const elapsed = Date.now() - new Date(cur.rescanIncompleteSince).getTime();
  return elapsed >= ctx.incompleteSuspendAfterMs ? "suspend" : "wait";
}

const startClock = (ctx: RowContext) => ({
  rescanIncompleteSince: new Date(),
  rescanIncompleteRuleSet: ctx.ruleSet,
});

const suspended = () => ({
  suspendedAt: new Date(),
  suspensionNotifiedAt: null,
  suspendedReason: REASON,
});

async function audit(
  tx: KobeTx,
  ctx: RowContext,
  at: { skillId: string; slug: string; version: number },
  scope: "team" | "personal",
  teamId?: string,
): Promise<void> {
  await recordAudit(tx, {
    action: "skill.rescan.suspended",
    actor: SYSTEM_ACTOR,
    ...(teamId ? { teamId } : {}),
    target: { ...at, scope, ruleSetVersion: ctx.ruleSetVersion, reason: REASON },
  });
}

/** A team review row whose rescan didn't finish: an approved, unsuspended version may suspend. */
export async function noteIncompleteReview(
  ctx: RowContext,
  teamId: string,
  row: ReviewKey,
  authorId: string,
  tally: Tally,
): Promise<void> {
  await withTeam(ctx.db, teamId, async (tx) => {
    const key = and(
      eq(teamSkillReviews.teamId, teamId),
      eq(teamSkillReviews.skillId, row.skillId),
      eq(teamSkillReviews.version, row.version),
    );
    const [cur] = await tx
      .select({
        status: teamSkillReviews.status,
        ruleSet: teamSkillReviews.ruleSet,
        suspendedAt: teamSkillReviews.suspendedAt,
        rescanIncompleteSince: teamSkillReviews.rescanIncompleteSince,
        rescanIncompleteRuleSet: teamSkillReviews.rescanIncompleteRuleSet,
      })
      .from(teamSkillReviews)
      .where(key)
      .for("update");
    const step = cur ? decide(ctx, cur) : null;
    if (step === "start") {
      await tx.update(teamSkillReviews).set(startClock(ctx)).where(key);
      return;
    }
    if (step !== "suspend" || cur?.status !== "approved" || cur.suspendedAt !== null) return;
    // The approval is kept, so a finished rescan that doesn't block can lift it.
    await tx.update(teamSkillReviews).set(suspended()).where(key);
    const at = { skillId: row.skillId, slug: row.slug, version: row.version };
    await audit(tx, ctx, at, row.scope, teamId);
    tally.suspended.push({ ...at, scope: row.scope, teamId, authorId });
  });
}

/** A personal version's own scan whose rescan didn't finish: a Pass version may suspend. */
export async function noteIncompletePersonal(
  ctx: RowContext,
  row: { skillId: string; version: number; slug: string; ownerId: string },
  tally: Tally,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const key = and(
      eq(personalSkillScans.skillId, row.skillId),
      eq(personalSkillScans.version, row.version),
    );
    const [cur] = await tx
      .select({
        findings: personalSkillScans.findings,
        skipped: personalSkillScans.skipped,
        ruleSet: personalSkillScans.ruleSet,
        suspendedAt: personalSkillScans.suspendedAt,
        rescanIncompleteSince: personalSkillScans.rescanIncompleteSince,
        rescanIncompleteRuleSet: personalSkillScans.rescanIncompleteRuleSet,
      })
      .from(personalSkillScans)
      .where(key)
      .for("update");
    const step = cur ? decide(ctx, cur) : null;
    if (step === "start") {
      await tx.update(personalSkillScans).set(startClock(ctx)).where(key);
      return;
    }
    if (step !== "suspend" || !cur || cur.suspendedAt !== null) return;
    if (storedVerdict(cur) !== "pass") return;
    await tx.update(personalSkillScans).set(suspended()).where(key);
    const at = { skillId: row.skillId, slug: row.slug, version: row.version };
    await audit(tx, ctx, at, "personal");
    tally.suspended.push({ ...at, scope: "personal", authorId: row.ownerId });
  });
}
