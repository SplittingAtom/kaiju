import { Hono } from "hono";
import { slugFromName } from "@kobe/agent-file";
import { agentAccess, canCreateAgent } from "../../agents/access.js";
import {
  agentBodyLimit,
  agentResponse,
  createError,
  forbidden,
  notFound,
  readAgentInput,
} from "../../agents/http.js";
import { agentIdSchema, agentStatusSchema, createMetaSchema } from "../../agents/schemas.js";
import { createAgent } from "../../agents/store.js";
import { currentGalleryScores, galleryScoreView } from "../../agents/eval/gallery-scores.js";
import { inventoryQuerySchema, listInventory, setInventoryStatus } from "../../agents/inventory.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { actorOf, refuseDangerous, locationFor, type AgentKit } from "./shared.js";

/** Gallery scores (KOBE-94), the team inventory (KOBE-86) and creating an agent. */
export function agentCollectionRoutes(kit: AgentKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db } = kit;

  // Published Orbit scores of gallery agents (KOBE-94): before "/:id".
  app.get("/gallery-scores", async (c) => {
    const scores = await currentGalleryScores(db);
    return c.json({ scores: scores.map(galleryScoreView) });
  });

  // Team admins' inventory (KOBE-86): before "/:id" so "inventory" is not read as an id.
  app.get("/inventory", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.agents.suspend")) {
      return forbidden(c, "Only team admins see the agent inventory.");
    }
    const query = inventoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Check limit and cursor.");
    const page = await listInventory(db, c.get("team").id, query.data);
    const actor = actorOf(c);
    return c.json({
      ...page,
      // Per row: exporting needs the right to read that agent's definition (KOBE-91).
      agents: page.agents.map((a) => ({
        ...a,
        canExport: agentAccess(actor, { scope: a.scope, ownerUserId: a.ownerUserId })
          .readDefinition,
      })),
    });
  });

  app.put("/inventory/:id/status", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.agents.suspend")) {
      return forbidden(c, "Only team admins suspend agents.");
    }
    const id = param(c, "id", agentIdSchema);
    const body = await parseBody(c, agentStatusSchema);
    if (!body) return invalidRequest(c, "status must be active or suspended.");
    if (!id.success) return notFound(c);
    const result = await setInventoryStatus(
      db,
      c.get("team").id,
      c.get("user").id,
      id.data,
      body.status,
    );
    if (!result.ok) return notFound(c);
    return c.json({ id: id.data, scope: result.scope, status: body.status });
  });

  app.post("/", agentBodyLimit, async (c) => {
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    const meta = createMetaSchema.safeParse(input.meta);
    if (!meta.success)
      return invalidRequest(c, "Give scope (team or personal) and optionally a slug.");
    if (!canCreateAgent(c.get("team").role, meta.data.scope)) {
      return forbidden(c, "Your team role doesn't allow creating team agents.");
    }
    const dangerous = refuseDangerous(c, input.definition);
    if (dangerous) return dangerous;
    const result = await createAgent(db, locationFor(c, meta.data.scope), {
      definition: input.definition,
      slug: meta.data.slug,
      baseSlug: slugFromName(input.definition.frontmatter.name),
      ownerUserId: c.get("user").id,
      source: input.source,
    });
    if (!result.ok) return createError(c, result.error);
    return agentResponse(c, result.value, agentAccess(actorOf(c), result.value), 201);
  });

  return app;
}
