import { Hono } from "hono";
import { memoryPutRequestSchema, memoryScopeSchema } from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { listMemory, writeMemory } from "../../memory/store.js";
import { uuidSchema } from "../../threads/schemas.js";
import { invalidRequest, param, readJson } from "../../http/request.js";
import { NOT_FOUND, fail, summary, type MemoryKit } from "./shared.js";

/** Listing, writing and reading memory docs. */
export function memoryDocRoutes(kit: MemoryKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { run, resolveTarget, resolveDoc, detail, panelActor } = kit;

  app.get("/", (c) => {
    const scope = memoryScopeSchema.safeParse(c.req.query("scope"));
    if (!scope.success) return invalidRequest(c, "Send scope=user or scope=project.");
    return run(c, async (tx) => {
      const target = await resolveTarget(tx, c, scope.data, c.req.query("project_id"));
      if (!target.ok) return target;
      const docs = await listMemory(tx, c.get("team").id, target.value);
      return { ok: true, value: { docs: docs.map(summary) } };
    });
  });

  app.put("/", async (c) => {
    const parsed = memoryPutRequestSchema.safeParse(await readJson(c, null));
    if (!parsed.success) return invalidRequest(c);
    const body = parsed.data;
    return run(c, async (tx, blobs) => {
      const teamId = c.get("team").id;
      const target = await resolveTarget(tx, c, body.scope, c.req.query("project_id"), true);
      if (!target.ok) return target;
      const written = await writeMemory(
        tx,
        blobs,
        teamId,
        target.value,
        {
          path: body.path,
          content: body.content,
          ...(body.expected_version !== undefined
            ? { expectedVersion: body.expected_version }
            : {}),
        },
        panelActor(c),
      );
      if (!written.ok) {
        const status =
          written.code === "version_conflict" ? 409 : written.code === "too_large" ? 413 : 422;
        return fail(status, {
          code: written.code,
          message: written.message,
          ...("currentVersion" in written ? { current_version: written.currentVersion } : {}),
        });
      }
      await recordAudit(tx, {
        action: "memory.written",
        teamId,
        target: {
          scope: body.scope,
          memoryDocId: written.docId,
          version: written.version,
          ...(written.previousVersion !== undefined
            ? { previousVersion: written.previousVersion }
            : {}),
          actorKind: "user",
          sizeBytes: written.sizeBytes,
        },
      });
      return { ok: true, value: await detail(tx, blobs, teamId, written.docId) };
    });
  });

  app.get("/:id", (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c);
    return run(c, async (tx, blobs) => {
      const doc = await resolveDoc(tx, c, id.data);
      if (!doc.ok) return doc;
      if (doc.value.deletedAt !== null) return fail(404, NOT_FOUND);
      return { ok: true, value: await detail(tx, blobs, c.get("team").id, id.data) };
    });
  });

  return app;
}
