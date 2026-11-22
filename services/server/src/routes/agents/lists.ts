import { Hono } from "hono";
import { agentAccess, type AgentScope } from "../../agents/access.js";
import { agentSummary } from "../../agents/http.js";
import { listQuerySchema } from "../../agents/schemas.js";
import { listAgents } from "../../agents/store.js";
import { listRunnableAgents, runnableQuerySchema } from "../../agents/runnable.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { invalidRequest } from "../../http/request.js";
import { actorOf, locationFor, type AgentKit } from "./shared.js";

/** The agent list and the agents the caller can start a chat with (KOBE-122). */
export function agentListRoutes(kit: AgentKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db } = kit;

  app.get("/", async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "scope must be team, personal or gallery.");
    const scopes: AgentScope[] = query.data.scope
      ? [query.data.scope]
      : ["team", "personal", "gallery"];
    const actor = actorOf(c);
    const archived = query.data.include_archived === "true";
    const lists = await Promise.all(scopes.map((s) => listAgents(db, locationFor(c, s))));
    const agents = lists
      .flat()
      .filter((agent) => archived || agent.archivedAt === null)
      .map((agent) => ({ agent, access: agentAccess(actor, agent) }))
      .filter(({ access }) => access.see)
      .map(({ agent, access }) => agentSummary(agent, access));
    return c.json({ agents });
  });

  // Agents the caller can start a chat with (KOBE-122): before "/:id".
  app.get("/runnable", async (c) => {
    const query = runnableQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Check limit and cursor.");
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    return c.json(await listRunnableAgents(db, viewer, query.data));
  });

  return app;
}
