import { Hono } from "hono";
import { agentWarnings } from "@kobe/agent-file";
import { AGENT_FORK_SCOPE_IGNORED } from "@kobe/protocol";
import { agentAccess, canForkAgent, forkBinding } from "../../agents/access.js";
import {
  agentDetail,
  agentResponse,
  createError,
  etag,
  forbidden,
  notFound,
} from "../../agents/http.js";
import { agentIdSchema, agentStatusSchema, forkSchema } from "../../agents/schemas.js";
import { createAgent, setAgentStatus } from "../../agents/store.js";
import { findForkSource, forkDefinition } from "../../agents/fork.js";
import { rosterError } from "../agent-roster.js";
import { type TeamVariables } from "../../authz/middleware.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { actorOf, forkable, locationFor, type AgentKit } from "./shared.js";

/** Forking an agent and suspending or reactivating it. */
export function agentLifecycleRoutes(kit: AgentKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { db, visible } = kit;

  /**
   * Fork (KOBE-568, agents-roster AR8, §6.7): always a personal agent of the caller's, from the
   * source's published version (or the draft of their own unpublished agent), with fork provenance
   * and, for team content, bound to that team.
   */
  app.post("/:id/fork", async (c) => {
    const id = param(c, "id", agentIdSchema);
    if (!id.success) return notFound(c);
    const body = await parseBody(c, forkSchema);
    if (!body) return invalidRequest(c, "Give optionally a slug.");
    const actor = actorOf(c);
    const caller = { teamId: c.get("team").id, userId: actor.userId };
    const source = await findForkSource(db, caller, id.data);
    if (!source) return notFound(c);
    if (!canForkAgent(actor, source.via)) return forbidden(c, "You can't copy this agent.");
    const copied = await forkDefinition(db, source);
    if (!copied)
      return rosterError(c, "agent_not_published", "This agent has no published version yet.");
    const boundTeamId = forkBinding(source.via, source.boundTeamId, caller.teamId);
    const definition = forkable(c, copied.definition);
    const named =
      body.name === undefined
        ? definition
        : { ...definition, frontmatter: { ...definition.frontmatter, name: body.name } };
    const result = await createAgent(db, locationFor(c, "personal"), {
      definition: named,
      slug: body.slug,
      baseSlug: source.agent.slug,
      ownerUserId: actor.userId,
      source: "fork",
      forkedFrom: source.agent.id,
      forkedFromVersion: copied.version,
      boundTeamId,
    });
    if (!result.ok) return createError(c, result.error);
    const fork = result.value;
    c.header("ETag", etag(fork));
    return c.json(
      {
        agent: agentDetail(fork, agentAccess(actor, fork)),
        boundTeamId,
        warnings: [
          ...agentWarnings(fork.frontmatter),
          ...(body.scope === undefined ? [] : [AGENT_FORK_SCOPE_IGNORED]),
        ],
      },
      201,
    );
  });

  app.put("/:id/status", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const body = await parseBody(c, agentStatusSchema);
    if (!body) return invalidRequest(c, "status must be active or suspended.");
    const access = agentAccess(actorOf(c), agent);
    if (!access.setStatus) return forbidden(c, "Only team admins suspend team agents.");
    const updated = await setAgentStatus(db, locationFor(c, agent.scope), agent.id, body.status);
    if (!updated) return notFound(c);
    return agentResponse(c, updated, access);
  });

  return app;
}
