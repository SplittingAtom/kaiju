import { Hono } from "hono";
import { withTeam } from "@kobe/db";
import {
  createProjectRequestSchema,
  listProjectsQuerySchema,
  updateProjectRequestSchema,
} from "@kobe/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import { decide } from "../../projects/access.js";
import {
  createProject,
  deleteProject,
  listOwnerless,
  listProjects,
  toProject,
  updateProject,
} from "../../projects/repository.js";
import { invalidRequest, parseBody } from "../../http/request.js";
import { failure, isSlugConflict, type ProjectKit } from "./shared.js";

/** Creating, listing, reading, changing and deleting projects (and the ownerless list, PR5). */
export function projectCoreRoutes(kit: ProjectKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, viewerOf, withProject } = kit;

  app.post("/", async (c) => {
    const body = await parseBody(c, createProjectRequestSchema);
    if (!body)
      return invalidRequest(c, "Check the project fields (name, slug, instructions up to 8 KiB).");
    if (!decide(c.get("team").role, undefined).can.create) return failure(c, "forbidden");
    const viewer = viewerOf(c);
    try {
      const res = await withTeam(db, viewer.teamId, async (tx) => {
        const created = await createProject(tx, viewer, body);
        if (!created.ok) return failure(c, created.error);
        const { row } = created.value;
        return c.json(await toProject(tx, viewer.teamId, row, "owner"), 201);
      });
      // PF5 (KOBE-586): a new project mounts for its creator at once (MT1 creator rule).
      if (res.status === 201) await deps.projectMounts.reconcileUser(viewer.teamId, viewer.userId);
      return res;
    } catch (err) {
      if (isSlugConflict(err)) return failure(c, "slug_taken");
      throw err;
    }
  });

  app.get("/", async (c) => {
    const query = listProjectsQuerySchema.safeParse(c.req.query());
    if (!query.success)
      return invalidRequest(c, "role may only be editor; include_archived true or false.");
    const viewer = viewerOf(c);
    const list = await withTeam(db, viewer.teamId, (tx) =>
      listProjects(tx, viewer, {
        includeArchived: query.data.include_archived ?? false,
        teamRole: c.get("team").role,
        editorOnly: query.data.role === "editor",
      }),
    );
    return c.json({ projects: list });
  });

  /** PR5: projects whose only owner left the workspace, for team admins ("No owner: assign one"). */
  app.get("/no-owner", async (c) => {
    if (!decide(c.get("team").role, undefined).can.manage_members) {
      return failure(c, "forbidden");
    }
    const query = listProjectsQuerySchema.safeParse(c.req.query());
    if (!query.success || query.data.role !== undefined) {
      return invalidRequest(c, "Only include_archived (true or false) is accepted.");
    }
    const teamId = viewerOf(c).teamId;
    const list = await withTeam(db, teamId, (tx) =>
      listOwnerless(tx, teamId, { includeArchived: query.data.include_archived ?? false }),
    );
    return c.json({ projects: list });
  });

  app.get("/:id", (c) =>
    withProject(c, "view", async (tx, a) =>
      c.json(await toProject(tx, a.project.teamId, a.project, a.role)),
    ),
  );

  app.patch("/:id", async (c) => {
    const body = await parseBody(c, updateProjectRequestSchema);
    if (!body) return invalidRequest(c, "Check the project fields (instructions up to 8 KiB).");
    return withProject(c, "manage", async (tx, access) => {
      const updated = await updateProject(tx, viewerOf(c), access, body);
      if (!updated.ok) return failure(c, updated.error);
      return c.json(await toProject(tx, access.project.teamId, updated.value.row, access.role));
    });
  });

  app.delete("/:id", (c) =>
    withProject(c, "manage", async (tx, access) => {
      const deleted = await deleteProject(tx, viewerOf(c), access.project.id);
      return deleted.ok ? c.body(null, 204) : failure(c, deleted.error, deleted.detail);
    }),
  );

  return app;
}
