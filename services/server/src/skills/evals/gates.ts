import { and, eq, teamSkillReviews, teamSkillVersions, type KobeTx, type TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import { isBlocked } from "../blocklist.js";
import { testGate, type TestGate } from "../drafts/test-gates.js";

/** Who is evaluating: the starter, in the eval's team. */
export interface EvalGateWho {
  readonly teamId: string;
  readonly userId: string;
  readonly role: TeamRole;
}

/**
 * Who may evaluate a team version (P2-12, owner decision 2026-11-22): any member once it is
 * approved and not suspended; while it is pending (or suspended, or has no review row) only its
 * uploader and holders of `team.skills.publish` or `team.skills.review`; nobody once rejected.
 */
export async function teamVersionGate(
  tx: KobeTx,
  who: EvalGateWho,
  skillId: string,
  seq: number,
): Promise<"review_pending" | "review_rejected" | null> {
  const [row] = await tx
    .select({
      status: teamSkillReviews.status,
      suspendedAt: teamSkillReviews.suspendedAt,
      uploadedBy: teamSkillVersions.uploadedBy,
    })
    .from(teamSkillVersions)
    .leftJoin(
      teamSkillReviews,
      and(
        eq(teamSkillReviews.teamId, teamSkillVersions.teamId),
        eq(teamSkillReviews.skillId, teamSkillVersions.skillId),
        eq(teamSkillReviews.version, teamSkillVersions.version),
      ),
    )
    .where(
      and(
        eq(teamSkillVersions.teamId, who.teamId),
        eq(teamSkillVersions.skillId, skillId),
        eq(teamSkillVersions.seq, seq),
      ),
    );
  if (row?.status === "rejected") return "review_rejected";
  if (row?.status === "approved" && row.suspendedAt === null) return null;
  const mayTest =
    row?.uploadedBy === who.userId ||
    teamRoleAllows(who.role, "team.skills.publish") ||
    teamRoleAllows(who.role, "team.skills.review");
  return mayTest ? null : "review_pending";
}

export type EvalGateRefusal = "skill_blocklisted" | "review_pending" | "review_rejected" | TestGate;

/** Each refusal's HTTP status (at start) and message (at start, and as a claimed run's failure). */
export const EVAL_GATE_REFUSALS: Readonly<Record<EvalGateRefusal, readonly [403 | 409, string]>> = {
  skill_blocklisted: [409, "This skill is on the site's blocklist."],
  review_rejected: [403, "This version was rejected in review, so it can't be evaluated."],
  review_pending: [
    403,
    "This version is waiting for review: only its uploader and those who publish or review the team's skills can evaluate it.",
  ],
  personal_skills_disabled: [403, "This team's settings don't allow evaluating this skill."],
  skill_declined: [403, "This team's settings don't allow evaluating this skill."],
};

/**
 * The gates of an eval subject at a moment (start, and again when each execution is claimed:
 * review g79): the blocklist, then the team version's review, or the test-chat gates for a draft
 * or personal version. A Registry version is the Registry team's own review (KOBE-335).
 */
export async function evalSubjectGate(
  tx: KobeTx,
  who: EvalGateWho,
  subject: { readonly kind: string; readonly id: string; readonly rev: number },
  runtimeHash: string,
): Promise<EvalGateRefusal | null> {
  if (await isBlocked(tx, runtimeHash)) return "skill_blocklisted";
  if (subject.kind === "team") return teamVersionGate(tx, who, subject.id, subject.rev);
  if (subject.kind !== "registry") return testGate(tx, who, runtimeHash);
  return null;
}
