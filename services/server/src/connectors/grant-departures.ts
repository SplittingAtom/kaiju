import {
  and,
  connectorGrants,
  connectors,
  eq,
  inArray,
  listMemberships,
  sql,
  SYSTEM_ACTOR,
  teams,
  users,
  withTeam,
  type AuditActor,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";

/**
 * A member's connector grants (API keys, OAuth tokens) end with their standing in the team
 * (KOBE-696, owner decision 2026-11-20): deleted, each with an `mcp.grant.removed` audit row naming
 * the member and the reason, when they are removed from the team, deactivated, or deprovisioned by
 * an identity provider. A re-added or reactivated member enters their keys again. Nothing is sent
 * to the upstream (no OAuth revocation call).
 */
export type GrantRemovalReason = "member_removed" | "deactivated" | "deprovisioned" | "reactivated";

export interface RemovedGrant {
  readonly connectorId: string;
  readonly name: string;
}

/** Deletes the member's grants in the caller's team transaction; audit them with {@link auditRemovedGrants}. */
export async function deleteMemberGrantsInTx(
  tx: KaijuTx,
  teamId: string,
  userId: string,
): Promise<RemovedGrant[]> {
  const removed = await tx
    .delete(connectorGrants)
    .where(and(eq(connectorGrants.teamId, teamId), eq(connectorGrants.userId, userId)))
    .returning({ connectorId: connectorGrants.connectorId });
  if (removed.length === 0) return [];
  const ids = removed.map((r) => r.connectorId);
  const named = await tx
    .select({ id: connectors.id, name: connectors.name })
    .from(connectors)
    .where(inArray(connectors.id, ids));
  const names = new Map(named.map((c) => [c.id, c.name]));
  return ids
    .sort()
    .map((connectorId) => ({ connectorId, name: names.get(connectorId) ?? "unknown" }));
}

/**
 * One `mcp.grant.removed` per deleted grant. The audit rows are the transaction's last writes (they
 * hold the audit chain lock until commit). `actor` defaults to the request's signed-in user.
 */
export async function auditRemovedGrants(
  tx: KaijuTx,
  teamId: string,
  userId: string,
  grants: readonly RemovedGrant[],
  reason: GrantRemovalReason,
  actor?: AuditActor,
): Promise<void> {
  for (const grant of grants) {
    await recordAudit(tx, {
      action: "mcp.grant.removed",
      teamId,
      ...(actor ? { actor } : {}),
      target: { connectorId: grant.connectorId, name: grant.name, userId, reason },
    });
  }
}

/** `deactivated` for a Site admin's deactivation, `deprovisioned` for an identity provider's (SCIM). */
async function deactivationReason(db: KaijuDb, userId: string): Promise<GrantRemovalReason> {
  const [row] = await db
    .select({ via: users.deactivatedVia })
    .from(users)
    .where(eq(users.id, userId));
  return row?.via?.startsWith("scim:") ? "deprovisioned" : "deactivated";
}

/**
 * The user's grants in every team they belong to, one `withTeam()` transaction per team (actor:
 * system). Returns how many were deleted; throws when a team failed (a lifecycle hook is then
 * reported incomplete, and the offboarding sweep finishes the job).
 */
async function deleteUserGrantsEverywhere(
  db: KaijuDb,
  userId: string,
  reason: GrantRemovalReason,
): Promise<number> {
  const memberships = await listMemberships(db, userId);
  let deleted = 0;
  const failures: unknown[] = [];
  for (const { teamId } of memberships) {
    try {
      deleted += await withTeam(db, teamId, async (tx) => {
        const grants = await deleteMemberGrantsInTx(tx, teamId, userId);
        await auditRemovedGrants(tx, teamId, userId, grants, reason, SYSTEM_ACTOR);
        return grants.length;
      });
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${memberships.length} teams' grants not deleted`,
    );
  }
  return deleted;
}

/** Deactivation (a lifecycle hook, after the deactivation committed). */
export async function deleteDeactivatedUserGrants(db: KaijuDb, userId: string): Promise<number> {
  return deleteUserGrantsEverywhere(db, userId, await deactivationReason(db, userId));
}

/**
 * Reactivation (a lifecycle hook, review of KOBE-696): a deactivated user cannot store grants, so
 * any they still have were left by a deactivation hook that failed before the sweep came round;
 * they must not work again. Reason `reactivated`.
 */
export async function deleteReactivatedUserGrants(db: KaijuDb, userId: string): Promise<number> {
  return deleteUserGrantsEverywhere(db, userId, "reactivated");
}

/** Grants deleted per team per sweep pass; the next pass goes on. */
export const GRANT_SWEEP_LIMIT = 500;

export interface GrantSweepOptions {
  readonly limit?: number;
  readonly log?: Pick<Logger, "error">;
}

/**
 * The backstop and the one-off cleanup (KOBE-696 ac-3): grants whose owner is no longer a member of
 * the team, or is deactivated, are deleted and audited (actor: system). Idempotent: run by every
 * offboarding sweep, so grants left from before KOBE-696 and any a failed hook left behind go at
 * the next sweep. One `withTeam()` transaction per team, at most `limit` grants each; the departure
 * is judged inside the DELETE itself, so a member re-added meanwhile keeps a key they stored. A
 * failing team is logged and skipped.
 */
export async function sweepDepartedGrants(
  db: KaijuDb,
  options: GrantSweepOptions = {},
): Promise<number> {
  const limit = options.limit ?? GRANT_SWEEP_LIMIT;
  let deleted = 0;
  for (const team of await db.select({ id: teams.id }).from(teams)) {
    try {
      deleted += await withTeam(db, team.id, (tx) => sweepTeamInTx(tx, team.id, limit));
    } catch (err) {
      (options.log ?? logger).error(
        { err, team_id: team.id },
        "departed members' connector grants cleanup failed",
      );
    }
  }
  return deleted;
}

const DEPARTED = (alias: string, user: string) =>
  sql.raw(`(
  NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = ${alias}.team_id AND m.user_id = ${alias}.user_id)
  OR ${user}.deactivated_at IS NOT NULL)`);

async function sweepTeamInTx(tx: KaijuTx, teamId: string, limit: number): Promise<number> {
  const removed = await tx.execute<{
    user_id: string;
    connector_id: string;
    name: string | null;
    reason: GrantRemovalReason;
  }>(sql`
    DELETE FROM connector_grants g
     USING users u
     WHERE g.team_id = ${teamId}
       AND u.id = g.user_id
       AND ${DEPARTED("g", "u")}
       AND (g.user_id, g.connector_id) IN (
             SELECT c.user_id, c.connector_id
               FROM connector_grants c JOIN users cu ON cu.id = c.user_id
              WHERE c.team_id = ${teamId} AND ${DEPARTED("c", "cu")}
              ORDER BY c.user_id, c.connector_id
              LIMIT ${limit})
    RETURNING g.user_id, g.connector_id,
              (SELECT name FROM connectors WHERE id = g.connector_id) AS name,
              CASE WHEN NOT EXISTS (SELECT 1 FROM team_members m
                                     WHERE m.team_id = g.team_id AND m.user_id = g.user_id)
                   THEN 'member_removed'
                   WHEN u.deactivated_via LIKE 'scim:%' THEN 'deprovisioned'
                   ELSE 'deactivated' END AS reason`);
  const rows = [...removed.rows].sort(
    (a, b) => a.user_id.localeCompare(b.user_id) || a.connector_id.localeCompare(b.connector_id),
  );
  // Audits last: they take the audit chain lock until this team's transaction commits.
  for (const row of rows) {
    const grant = { connectorId: row.connector_id, name: row.name ?? "unknown" };
    await auditRemovedGrants(tx, teamId, row.user_id, [grant], row.reason, SYSTEM_ACTOR);
  }
  return rows.length;
}
