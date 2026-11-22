import { Hono } from "hono";
import {
  addProjectMemberRequestSchema,
  transferOwnerRequestSchema,
  updateProjectMemberRequestSchema,
} from "@kobe/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import { endCheckoutsWithoutEditInTx } from "../../projects/offboard.js";
import {
  addMember,
  listMembers,
  removeMember,
  setMemberRole,
  transferOwner,
} from "../../projects/repository.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { failure, idParam, type ProjectContext, type ProjectKit } from "./shared.js";

/** A project's people: list, add, hand over ownership, change role, remove. */
export function projectMemberRoutes(kit: ProjectKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, viewerOf, withProject } = kit;

  app.get("/:id/members", (c) =>
    withProject(c, "view", async (tx, access) =>
      c.json({ members: await listMembers(tx, access.project.teamId, access.project.id) }),
    ),
  );

  app.post("/:id/members", async (c) => {
    const body = await parseBody(c, addProjectMemberRequestSchema);
    if (!body)
      return invalidRequest(
        c,
        "Give user_id and optionally role (owner or editor; every member already reads).",
      );
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const added = await addMember(tx, viewerOf(c), access.project.id, {
        userId: body.user_id,
        role: body.role ?? "editor",
      });
      return added.ok ? c.json(added.value, 201) : failure(c, added.error);
    });
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, body.user_id);
    return res;
  });

  /** PR5: hand the project to another member of the workspace (owners and team admins). */
  app.post("/:id/owner", async (c) => {
    const body = await parseBody(c, transferOwnerRequestSchema);
    if (!body) return invalidRequest(c, "Give user_id: the member who becomes owner.");
    return withProject(c, "manage_members", async (tx, access) => {
      const moved = await transferOwner(tx, viewerOf(c), access, body.user_id);
      return moved.ok ? c.json(moved.value) : failure(c, moved.error);
    });
  });

  const memberParam = (c: ProjectContext) => param(c, "user_id", idParam);

  app.patch("/:id/members/:user_id", async (c) => {
    const body = await parseBody(c, updateProjectMemberRequestSchema);
    const user = memberParam(c);
    if (!body || !user.success) {
      return invalidRequest(
        c,
        "Give role (owner or editor). To make someone a reader, remove their row.",
      );
    }
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const changed = await setMemberRole(tx, viewerOf(c), access, user.data, body.role);
      if (!changed.ok) return failure(c, changed.error);
      // Owner and editor both edit; kept so a role that cannot edit always ends a checkout (KOBE-579).
      await endCheckoutsWithoutEditInTx(tx, viewerOf(c).teamId, user.data);
      return c.json(changed.value);
    });
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, user.data);
    return res;
  });

  app.delete("/:id/members/:user_id", async (c) => {
    const user = memberParam(c);
    if (!user.success) return failure(c, "not_found");
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const removed = await removeMember(tx, viewerOf(c), access.project.id, user.data);
      if (!removed.ok) return failure(c, removed.error);
      // An implicit reader (or no one) now: a checkout of theirs ends (KOBE-579).
      await endCheckoutsWithoutEditInTx(tx, viewerOf(c).teamId, user.data);
      return c.body(null, 204);
    });
    // Still an implicit reader (RV1): the user's workspace is brought in line (a checkout ended).
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, user.data);
    return res;
  });

  return app;
}
