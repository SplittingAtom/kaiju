import { and, eq, inArray, teamMembers, users, type KaijuTx } from "@kaiju/db";
import { loadAccess } from "../projects/access.js";
import type { Viewer } from "./queries.js";

/**
 * How the projects of others' threads show to a viewer (CE20, KOBE-221): which they may open, the
 * masked `project_id` for the rest, and the names of the people who shared threads with them.
 */

/**
 * The projects of others' `rows` the viewer may open (member, or team admin), as the markers decide
 * (`project-moves.ts`). A team share can reach people outside the thread's project (CE20): they
 * see the thread, not which project it is in.
 */
export async function viewableProjects(
  tx: KaijuTx,
  viewer: Viewer,
  rows: readonly { readonly ownerUserId: string; readonly projectId: string | null }[],
): Promise<ReadonlySet<string>> {
  const visible = new Set(viewer.projectIds);
  const unknown = new Set(
    rows.flatMap((r) =>
      r.ownerUserId !== viewer.userId && r.projectId !== null && !visible.has(r.projectId)
        ? [r.projectId]
        : [],
    ),
  );
  for (const projectId of unknown) {
    if (await canViewProject(tx, viewer, projectId)) visible.add(projectId);
  }
  return visible;
}

/** Whether the viewer may open the project: a member, or a team admin (as the markers decide). */
export async function canViewProject(
  tx: KaijuTx,
  viewer: Viewer,
  projectId: string,
): Promise<boolean> {
  if (viewer.projectIds.includes(projectId)) return true;
  return (await loadAccess(tx, viewer, projectId))?.can.view === true;
}

/** `project_id: null` for someone else's thread in a project the viewer may not open. */
export function maskedProject(
  row: { readonly ownerUserId: string; readonly projectId: string | null },
  viewer: Viewer,
  viewable: ReadonlySet<string>,
): { project_id?: null } {
  const hidden =
    row.ownerUserId !== viewer.userId && row.projectId !== null && !viewable.has(row.projectId);
  return hidden ? { project_id: null } : {};
}

/**
 * The names of the people who shared `rows` with the viewer ("Shared by …", CE20), only those
 * still in the active team: someone who left shows as null. Never the email address.
 */
export async function sharerNames(
  tx: KaijuTx,
  viewer: Viewer,
  rows: readonly { readonly ownerUserId: string }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((id) => id !== viewer.userId))];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, viewer.teamId), eq(teamMembers.userId, users.id)),
    )
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}
