import { Hono } from "hono";
import { agentWarnings } from "@kaiju/agent-file";
import { agentAccess } from "../../agents/access.js";
import {
  agentBodyLimit,
  agentDetail,
  agentResponse,
  agentSummary,
  archivedConflict,
  etag,
  exportResponse,
  forbidden,
  notFound,
  preconditionFailed,
  readAgentInput,
  ifMatchRevision,
} from "../../agents/http.js";
import { updateMetaSchema } from "../../agents/schemas.js";
import { updateAgent } from "../../agents/store.js";
import { AgentRosteredError, refuseIfRostered } from "../../agents/roster.js";
import { pendingTransfer } from "../../agents/roster-transfer.js";
import { rosterError } from "../agent-roster.js";
import { deleteOrArchiveAgent } from "../../agents/versions.js";
import { recordAuditAfter } from "../../audit/record.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { invalidRequest } from "../../http/request.js";
import { actorOf, refuseDangerous, locationFor, type AgentKit } from "./shared.js";

/** One agent: read (or its roster or transfer view), export, update, delete or archive. */
export function agentDefinitionRoutes(kit: AgentKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, visible, rosterView, offeredAgent } = kit;

  app.get("/:id", async (c) => {
    const agent = await visible(c);
    if (!agent) return (await rosterView(c)) ?? offeredAgent(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.readDefinition) return c.json({ agent: agentSummary(agent, access) });
    if (agent.scope !== "personal") return agentResponse(c, agent, access);
    // The owner sees a pending transfer of their agent (KOBE-568, AR10).
    c.header("ETag", etag(agent));
    return c.json({
      agent: agentDetail(agent, access),
      warnings: agentWarnings(agent.frontmatter),
      transfer: await pendingTransfer(db, agent.id),
    });
  });

  app.get("/:id/export", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    if (!agentAccess(actorOf(c), agent).readDefinition) {
      return forbidden(c, "Your team role doesn't allow exporting team agents.");
    }
    await recordAuditAfter(db, {
      action: "agent.exported",
      teamId: agent.scope === "team" ? c.get("team").id : null,
      target: { agentId: agent.id, scope: agent.scope, slug: agent.slug },
    });
    return exportResponse(c, agent);
  });

  app.put("/:id", agentBodyLimit, async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.edit) return forbidden(c);
    const ifMatch = ifMatchRevision(c);
    if (!ifMatch.ok) return ifMatch.response;
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    if (!updateMetaSchema.safeParse(input.meta).success) {
      return invalidRequest(c, "Send only frontmatter and prompt; slugs can't change.");
    }
    const dangerous = refuseDangerous(c, input.definition);
    if (dangerous) return dangerous;
    const result = await updateAgent(
      db,
      locationFor(c, agent.scope),
      agent.id,
      input.definition,
      ifMatch.revision,
      input.source,
    );
    if (!result.ok) {
      if (result.error === "archived") return archivedConflict(c);
      return result.error === "not_found" ? notFound(c) : preconditionFailed(c);
    }
    return agentResponse(c, result.value, access);
  });

  /** Never published: deleted (204). Published: archived (200), its versions stay pinned. */
  app.delete("/:id", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.edit) return forbidden(c);
    // A never-published personal agent on a roster (or proposed) is not deleted (§6.3).
    const guard = agent.scope === "personal" ? () => refuseIfRostered(db, agent.id) : undefined;
    let removed;
    try {
      removed = await deleteOrArchiveAgent(
        db,
        locationFor(c, agent.scope),
        agent.id,
        undefined,
        null,
        guard,
      );
    } catch (err) {
      if (err instanceof AgentRosteredError) return rosterError(c, "agent_rostered");
      throw err;
    }
    if (!removed) return notFound(c);
    return removed.kind === "deleted" ? c.body(null, 204) : agentResponse(c, removed.agent, access);
  });

  return app;
}
