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
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * A member's connector grants (API keys, OAuth tokens) end with their standing in the team
 * (KOBE-696, owner decision 2026-11-20): deleted, each with an `mcp.grant.removed` audit row naming
 * the member and the reason, when they are removed from the team, deactivated, or deprovisioned by
 * an identity provider. A re-added or reactivated member enters their keys again. Nothing is sent
 * to the upstream (no OAuth revocation call).
 */
export type GrantRemovalReason = "member_removed" | "deactivated" | "deprovisioned";

export interface RemovedGrant {
  readonly connectorId: string;
  readonly name: string;
}

/** Deletes the member's grants in the caller's team transaction; audit them with {@link auditRemovedGrants}. */
export async function deleteMemberGrantsInTx(
  tx: KobeTx,
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
  tx: KobeTx,
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
async function deactivationReason(db: KobeDb, userId: string): Promise<GrantRemovalReason> {
  const [row] = await db
    .select({ via: users.deactivatedVia })
    .from(users)
    .where(eq(users.id, userId));
  return row?.via?.startsWith("scim:") ? "deprovisioned" : "deactivated";
}

/**
 * Deactivation (a lifecycle hook, after the deactivation committed): the user's grants in every team
 * they belong to, one `withTeam()` transaction per team. Returns how many were deleted. Throws when
 * a team failed (the hook is reported incomplete; the offboarding sweep finishes it).
 */
export async function deleteDeactivatedUserGrants(db: KobeDb, userId: string): Promise<number> {
  const reason = await deactivationReason(db, userId);
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

/**
 * The backstop and the one-off cleanup (KOBE-696 ac-3): grants whose owner is no longer a member of
 * the team, or is deactivated, are deleted and audited (actor: system). Idempotent: run by every
 * offboarding sweep, so grants left from before KOBE-696 and any a failed hook left behind go at
 * the next sweep. One `withTeam()` transaction per team.
 */
export async function sweepDepartedGrants(db: KobeDb): Promise<number> {
  let deleted = 0;
  for (const team of await db.select({ id: teams.id }).from(teams)) {
    deleted += await withTeam(db, team.id, async (tx) => {
      const departed = await tx.execute<{ user_id: string; reason: GrantRemovalReason }>(sql`
        SELECT DISTINCT g.user_id,
               CASE WHEN m.user_id IS NULL THEN 'member_removed'
                    WHEN u.deactivated_via LIKE 'scim:%' THEN 'deprovisioned'
                    ELSE 'deactivated' END AS reason
          FROM connector_grants g
          JOIN users u ON u.id = g.user_id
          LEFT JOIN team_members m ON m.team_id = g.team_id AND m.user_id = g.user_id
         WHERE g.team_id = ${team.id}
           AND (m.user_id IS NULL OR u.deactivated_at IS NOT NULL)
         ORDER BY g.user_id`);
      const removed: { userId: string; reason: GrantRemovalReason; grants: RemovedGrant[] }[] = [];
      for (const { user_id: userId, reason } of departed.rows) {
        removed.push({ userId, reason, grants: await deleteMemberGrantsInTx(tx, team.id, userId) });
      }
      // Audits last: they take the audit chain lock until this team's transaction commits.
      let count = 0;
      for (const { userId, reason, grants } of removed) {
        await auditRemovedGrants(tx, team.id, userId, grants, reason, SYSTEM_ACTOR);
        count += grants.length;
      }
      return count;
    });
  }
  return deleted;
}
