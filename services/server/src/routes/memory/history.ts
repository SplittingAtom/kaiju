import { Hono } from "hono";
import { memoryRestoreRequestSchema } from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { deleteMemory, restoreMemory } from "../../memory/store.js";
import { uuidSchema } from "../../threads/schemas.js";
import { invalidRequest, param, readJson } from "../../http/request.js";
import { NOT_FOUND, fail, type MemoryKit } from "./shared.js";

/** Deleting a memory doc and restoring an earlier version. */
export function memoryHistoryRoutes(kit: MemoryKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { run, resolveDoc, detail, panelActor } = kit;

  app.delete("/:id", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    const res = await run(c, async (tx) => {
      const doc = await resolveDoc(tx, c, id.data, true);
      if (!doc.ok) return doc;
      const teamId = c.get("team").id;
      const deleted = await deleteMemory(tx, teamId, id.data);
      if (!deleted) return fail(404, NOT_FOUND);
      await recordAudit(tx, {
        action: "memory.deleted",
        teamId,
        target: { scope: doc.value.scope, memoryDocId: id.data, version: deleted.version },
      });
      return { ok: true, value: {} };
    });
    return res.status === 200 ? c.body(null, 204) : res;
  });

  app.post("/:id/restore", async (c) => {
    const id = param(c, "id", uuidSchema);
    const body = memoryRestoreRequestSchema.safeParse(await readJson(c, null));
    if (!id.success || !body.success) return invalidRequest(c);
    return run(c, async (tx, blobs) => {
      const doc = await resolveDoc(tx, c, id.data, true);
      if (!doc.ok) return doc;
      const teamId = c.get("team").id;
      const restored = await restoreMemory(
        tx,
        blobs,
        teamId,
        id.data,
        body.data.version,
        panelActor(c),
      );
      if (!restored.ok)
        return fail(404, { code: "version_not_found", message: "No such version." });
      await recordAudit(tx, {
        action: "memory.restored",
        teamId,
        target: {
          scope: doc.value.scope,
          memoryDocId: id.data,
          fromVersion: restored.fromVersion,
          version: restored.version,
        },
      });
      return { ok: true, value: await detail(tx, blobs, teamId, id.data) };
    });
  });

  return app;
}
