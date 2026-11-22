import { Hono } from "hono";
import { type KobeTx } from "@kobe/db";
import { type TeamVariables } from "../../authz/middleware.js";
import { fileThreadRequestSchema } from "@kobe/protocol";
import { canCreateInProject } from "../../threads/references.js";
import { mountCapRefusal } from "../../projects/mounts.js";
import { restoreThread, trashThread, type Viewer } from "../../threads/repository.js";
import { moveThreadBodySchema } from "../../threads/schemas.js";
import { fileThread, moveThread, setArchived, setPinned } from "../../threads/organize.js";
import { invalidRequest, parseBody } from "../../http/request.js";
import { tooManyMounts, threadIdParam, type ThreadKit } from "./shared.js";

/** Organizing threads: pin and archive, move to a project, file in a folder, Trash and restore. */
export function threadOrganizeRoutes(kit: ThreadKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, change } = kit;

  /** Pin, unpin, archive, unarchive (CE19, KOBE-220): the owner's own; idempotent. */
  const organize = {
    pin: (tx: KobeTx, viewer: Viewer, id: string) => setPinned(tx, viewer, id, true),
    unpin: (tx: KobeTx, viewer: Viewer, id: string) => setPinned(tx, viewer, id, false),
    archive: (tx: KobeTx, viewer: Viewer, id: string) => setArchived(tx, viewer, id, true),
    unarchive: (tx: KobeTx, viewer: Viewer, id: string) => setArchived(tx, viewer, id, false),
  } as const;
  for (const [action, apply] of Object.entries(organize)) {
    app.post(`/:id/${action}`, async (c) => {
      const id = threadIdParam(c);
      if (!id) return invalidRequest(c);
      return change(c, (tx, viewer) => apply(tx, viewer, id));
    });
  }

  /** Move to project (CE19): where the caller may start a thread; the next run is marked. */
  app.post("/:id/move", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, moveThreadBodySchema);
    if (!id || !body) return invalidRequest(c, "Give project_id: a project id, or null.");
    let limit: number | undefined;
    const res = await change(c, async (tx, viewer) => {
      // MT3: moving into a project that is not open yet opens it, within the cap (the thread no
      // longer keeps its old project open).
      if (body.project_id !== null && (await canCreateInProject(tx, viewer, body.project_id))) {
        limit = await mountCapRefusal(tx, viewer, body.project_id, id);
        if (limit !== undefined) return { ok: false, error: "project_not_found" };
      }
      return moveThread(tx, viewer, id, body.project_id);
    });
    if (limit !== undefined) return tooManyMounts(c, limit);
    // MT1: in or out, the caller's mounts follow their conversations.
    if (res.ok) await deps.projectMounts.reconcileUser(c.get("team").id, c.get("user").id);
    return res;
  });

  /**
   * File in a team folder, or out of one (KOBE-534, TF3): the owner or a reader of the thread
   * (D23/CE20); idempotent, never activity.
   */
  app.post("/:id/file", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, fileThreadRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give folder_id: a folder id, or null.");
    return change(c, (tx, viewer) => fileThread(tx, viewer, id, body.folder_id));
  });

  app.delete("/:id", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const res = await change(c, (tx, viewer) => trashThread(tx, viewer, id));
    // MT1: trashing the last conversation in a project unmounts it.
    if (res.ok) await deps.projectMounts.reconcileUser(c.get("team").id, c.get("user").id);
    return res;
  });

  app.post("/:id/restore", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const res = await change(c, (tx, viewer) => restoreThread(tx, viewer, id));
    // MT1: a restored project conversation mounts its project again (the cap is not re-checked).
    if (res.ok) await deps.projectMounts.reconcileUser(c.get("team").id, c.get("user").id);
    return res;
  });

  return app;
}
