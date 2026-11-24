import { asc, desc, eq, sql, teamMembers, withTeam, type KaijuDb } from "@kaiju/db";
import type { VectorTable } from "./vector-store.js";

/** Who pays for an embedding call: a member in one of their Workspaces. */
export interface Payer {
  readonly teamId: string;
  readonly userId: string;
}

/** The Site admin who started a build, and their active Workspace (null: none). */
export interface BuildAdmin {
  readonly userId: string;
  readonly teamId: string | null;
}

/** One part of a build: the site-wide tables, then one Workspace at a time. */
export interface Target {
  readonly table: VectorTable;
  readonly teamId?: string;
  /** Undefined: nobody can pay (a Workspace without members); the target is skipped. */
  readonly payer?: Payer;
}

interface WorkspacePayer {
  readonly teamId: string;
  readonly payer: Payer | undefined;
  /** When the admin joined this Workspace; null when they are not in it. */
  readonly adminJoined: Date | null;
}

/** The admin when a member, else the earliest Team admin, else the earliest member. */
async function workspacePayer(
  db: KaijuDb,
  adminId: string,
  teamId: string,
): Promise<WorkspacePayer> {
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .select({ userId: teamMembers.userId, createdAt: teamMembers.createdAt })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(
        desc(sql`${teamMembers.userId} = ${adminId}`),
        desc(sql`${teamMembers.role} = 'team_admin'`),
        asc(teamMembers.createdAt),
      )
      .limit(1),
  );
  return {
    teamId,
    payer: row ? { teamId, userId: row.userId } : undefined,
    adminJoined: row?.userId === adminId ? row.createdAt : null,
  };
}

/**
 * The build's targets and their payers (KOBE-409 billing, KOBE-669). With an active Workspace the
 * admin pays for everything there, as before. Without one (the model is a Site setting, so saving
 * it must not depend on it) each Workspace pays for its own items: the admin when they are a
 * member, else its earliest Team admin (else earliest member); the Site and portable items are
 * paid by the admin in the Workspace they joined first, else by the first Workspace's payer.
 */
export async function buildTargets(
  db: KaijuDb,
  admin: BuildAdmin,
  teamIds: readonly string[],
): Promise<Target[]> {
  if (admin.teamId !== null) {
    const payer = { teamId: admin.teamId, userId: admin.userId };
    return [
      { table: "site", payer },
      { table: "portable", payer },
      ...teamIds.map((teamId) => ({ table: "workspace" as const, teamId, payer })),
    ];
  }
  const workspaces: WorkspacePayer[] = [];
  for (const teamId of teamIds) workspaces.push(await workspacePayer(db, admin.userId, teamId));
  const joined = workspaces
    .filter((w) => w.adminJoined !== null)
    .sort((a, b) => (a.adminJoined?.getTime() ?? 0) - (b.adminJoined?.getTime() ?? 0));
  const sitePayer = joined[0]?.payer ?? workspaces.find((w) => w.payer)?.payer;
  return [
    { table: "site", ...(sitePayer ? { payer: sitePayer } : {}) },
    { table: "portable", ...(sitePayer ? { payer: sitePayer } : {}) },
    ...workspaces.map((w) => ({
      table: "workspace" as const,
      teamId: w.teamId,
      ...(w.payer ? { payer: w.payer } : {}),
    })),
  ];
}
