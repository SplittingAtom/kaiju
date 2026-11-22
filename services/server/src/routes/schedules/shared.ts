import { imitatesAppContext, imitatesSkillRequest } from "@kobe/protocol";
import { listMemberships, withTeam, type KobeTx } from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import type { ServerDeps } from "../../deps.js";
import { RunError } from "../../runs/errors.js";
import { checkMentionsExist } from "../../runs/mentions.js";
import { capReached, scheduleError, type Answer } from "../../schedules/http.js";
import { withUserScheduleLock } from "../../schedules/user-lock.js";
import {
  agentRunnable,
  atCap,
  countActiveElsewhere,
  countActiveHere,
  findSchedule,
  type ScheduleRow,
} from "../../schedules/store.js";

/**
 * Only the server writes a skill line or app context into a run's input (KOBE-439, KOBE-451
 * review LOW-7): a schedule's prompt that imitates them is refused when it is saved.
 */
export const MARKERS_REFUSED = "A prompt can't contain Kobe's skill or app-context markers.";
export const serverMarkers = (prompt: string) =>
  imitatesSkillRequest(prompt) || imitatesAppContext(prompt);

/** A schedule's `@file` mentions checked against the owner's workspace now (KOBE-223 S3). */
export async function mentionsAnswer(
  tx: KobeTx,
  owner: { readonly teamId: string; readonly userId: string },
  mentions: readonly string[],
): Promise<Answer | null> {
  try {
    await checkMentionsExist(tx, owner, mentions);
    return null;
  } catch (err) {
    if (err instanceof RunError && err.code === "invalid_mention") {
      return scheduleError("invalid_mention", { message: err.message });
    }
    throw err;
  }
}

/**
 * A schedule paused because its agent became unavailable (agents-roster AR11, KOBE-567) resumes
 * only once the agent (or the one the same edit switches to) can start a thread for its owner.
 */
export async function agentBack(
  tx: KobeTx,
  row: { teamId: string; userId: string; agentId: string; pausedBy: string | null },
  newAgent?: string,
): Promise<boolean> {
  if (
    row.pausedBy !== "agent_unavailable" ||
    (newAgent !== undefined && newAgent !== row.agentId)
  ) {
    return true;
  }
  return agentRunnable(tx, { teamId: row.teamId, userId: row.userId }, row.agentId);
}

export type ScheduleKit = ReturnType<typeof scheduleKit>;

/** What the schedule route groups share: team admin check, the capped team transaction, lookups. */
export function scheduleKit(deps: ServerDeps) {
  const db = deps.database.db;

  const isAdmin = (c: { get: (k: "team") => { role: Parameters<typeof teamRoleAllows>[0] } }) =>
    teamRoleAllows(c.get("team").role, "team.schedules.pause");

  /** The teams a user belongs to besides `teamId` (read before the transaction: no pool deadlock). */
  const otherTeams = async (userId: string, teamId: string): Promise<string[]> =>
    (await listMemberships(db, userId)).map((m) => m.teamId).filter((t) => t !== teamId);

  /**
   * Runs `fn` in the active team's transaction. With `capped`, the owner's cap check is serialized
   * across requests and replicas, and `fn` gets the owner's active schedules in their other teams.
   */
  const inTeam = async <T>(
    teamId: string,
    owner: string,
    capped: boolean,
    fn: (tx: KobeTx, elsewhere: number) => Promise<T>,
  ): Promise<T> => {
    if (!capped) return withTeam(db, teamId, (tx) => fn(tx, 0));
    const others = await otherTeams(owner, teamId);
    return withUserScheduleLock(db, owner, async () => {
      const elsewhere = await countActiveElsewhere(db, owner, others);
      return withTeam(db, teamId, (tx) => fn(tx, elsewhere));
    });
  };

  /**
   * The cap answer when `owner` would exceed 10 active schedules. A team admin acting for someone
   * else learns only the code, never the owner's cross-team count.
   */
  const capAnswer = async (
    tx: KobeTx,
    owner: string,
    teamId: string,
    elsewhere: number,
    caller: string,
  ): Promise<Answer | null> => {
    const active = (await countActiveHere(tx, teamId, owner)) + elsewhere;
    if (!atCap(active)) return null;
    return owner === caller ? capReached(active) : scheduleError("schedule_cap_reached");
  };

  /** The caller's own schedule, locked for update; null (404) for anyone else's. */
  const loadOwn = async (
    tx: KobeTx,
    teamId: string,
    userId: string,
    id: string,
  ): Promise<ScheduleRow | null> => {
    const row = await findSchedule(tx, teamId, id);
    return row && row.userId === userId ? row : null;
  };

  return { deps, db, isAdmin, otherTeams, inTeam, capAnswer, loadOwn };
}
