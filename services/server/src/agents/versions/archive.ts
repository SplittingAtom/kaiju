import {
  and,
  eq,
  siteAgents,
  teamAgents,
  type AuditActor,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../../audit/record.js";
import {
  auditTeam,
  inLocation,
  siteWhere,
  SITE,
  lockAgent,
  TEAM,
  toRecord,
  type AgentLocation,
  type AgentRecord,
  type Row,
} from "../store.js";
import { ref } from "./records.js";

/** Deleting, archiving and unarchiving agents (KOBE-45 decision 6, KOBE-254). */

export type Removed =
  { readonly kind: "deleted" } | { readonly kind: "archived"; readonly agent: AgentRecord };

/**
 * Deletes an agent that was never published (nothing can reference it) or archives one that was
 * (KOBE-45 decision 6): its versions stay, threads pinned to them keep working, it can't be
 * edited, published or pinned by new threads. Archiving twice changes nothing. Null when the agent
 * doesn't exist in `location`.
 */
export async function deleteOrArchiveAgent(
  db: KaijuDb,
  location: AgentLocation,
  id: string,
  actor?: AuditActor,
  archivedBy: "seed" | null = null,
  beforeDelete?: () => Promise<void>, // under the row lock; throws to refuse (KOBE-566)
): Promise<Removed | null> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return null;
    if (agent.currentVersion === null) {
      await beforeDelete?.();
      if (location.scope === "team") {
        await tx.delete(teamAgents).where(eq(teamAgents.id, id));
      } else {
        await tx.delete(siteAgents).where(and(siteWhere(location), eq(siteAgents.id, id)));
      }
      await recordAudit(tx, {
        ...(actor ? { actor } : {}),
        action: "agent.deleted",
        teamId: auditTeam(location),
        target: ref(location, agent),
      });
      return { kind: "deleted" };
    }
    return { kind: "archived", agent: await archiveLocked(tx, location, agent, actor, archivedBy) };
  });
}

/**
 * Archives an agent whether or not it was ever published, never deleting it (KOBE-254: the seed
 * retiring gallery agents whose definition left the repo). Idempotent; null when it isn't there.
 */
export async function archiveAgent(
  db: KaijuDb,
  location: AgentLocation,
  id: string,
  actor: AuditActor,
  archivedBy: "seed" | null,
): Promise<AgentRecord | null> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    return agent ? archiveLocked(tx, location, agent, actor, archivedBy) : null;
  });
}

async function archiveLocked(
  tx: KaijuTx,
  location: AgentLocation,
  agent: AgentRecord,
  actor: AuditActor | undefined,
  archivedBy: "seed" | null,
): Promise<AgentRecord> {
  if (agent.archivedAt) return agent;
  const archived = await setArchived(tx, location, agent.id, new Date(), archivedBy);
  await recordAudit(tx, {
    ...(actor ? { actor } : {}),
    action: "agent.archived",
    teamId: auditTeam(location),
    target: ref(location, agent),
  });
  return archived;
}

/** Brings an archived agent back (editable, publishable, pinnable). Null when it isn't there. */
export async function unarchiveAgent(
  db: KaijuDb,
  location: AgentLocation,
  id: string,
): Promise<AgentRecord | null> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return null;
    if (!agent.archivedAt) return agent;
    const restored = await setArchived(tx, location, id, null);
    await recordAudit(tx, {
      action: "agent.unarchived",
      teamId: auditTeam(location),
      target: ref(location, agent),
    });
    return restored;
  });
}

async function setArchived(
  tx: KaijuTx,
  location: AgentLocation,
  id: string,
  archivedAt: Date | null,
  archivedBy: "seed" | null = null,
): Promise<AgentRecord> {
  const set = { archivedAt, updatedAt: new Date() };
  const [row]: Row[] =
    location.scope === "team"
      ? await tx.update(teamAgents).set(set).where(eq(teamAgents.id, id)).returning(TEAM)
      : await tx
          .update(siteAgents)
          .set({ ...set, archivedBy })
          .where(and(siteWhere(location), eq(siteAgents.id, id)))
          .returning(SITE);
  if (!row) throw new Error("agent archive update returned no row");
  return toRecord(location.scope, row);
}
