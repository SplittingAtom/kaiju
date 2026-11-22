import { type Context } from "hono";
import { agentWarnings, isDangerousMode, type AgentDefinition } from "@kobe/agent-file";
import { agentAccess, type AgentActor, type AgentScope } from "../../agents/access.js";
import { agentDetail, agentSummary, notFound } from "../../agents/http.js";
import { agentIdSchema } from "../../agents/schemas.js";
import {
  findAgent,
  findVisibleAgent,
  type AgentLocation,
  type AgentRecord,
} from "../../agents/store.js";
import { pendingTransfer } from "../../agents/roster-transfer.js";
import { ROSTER_READ_ACCESS, rosterDefinitionRead } from "../../agents/roster-read.js";
import { DANGEROUS_FORBIDDEN, mayUseDangerousMode } from "../../policy/dangerous-mode.js";
import { type TeamVariables } from "../../authz/middleware.js";
import type { ServerDeps } from "../../deps.js";
import { param } from "../../http/request.js";

export type Ctx = Context<{ Variables: TeamVariables }>;

/** What the recipient of a transfer may do with the offered agent before accepting: look. */
export const NO_ACCESS = {
  see: true,
  readDefinition: false,
  edit: false,
  publish: false,
  setStatus: false,
};

export const actorOf = (c: Ctx): AgentActor => ({
  userId: c.get("user").id,
  role: c.get("team").role,
});

/** AC1: site admins (and the Owner) and the active team's admins may use Dangerous mode. */
export const mayDangerous = (c: Ctx): boolean =>
  mayUseDangerousMode(c.get("team").role, c.get("siteRole"));

/** A definition in Dangerous mode from someone who may not set it (403), else null. */
export const refuseDangerous = (c: Ctx, definition: AgentDefinition): Response | null =>
  isDangerousMode(definition.frontmatter) && !mayDangerous(c)
    ? c.json(DANGEROUS_FORBIDDEN, 403)
    : null;

/** A fork by someone who may not use Dangerous mode drops it: the copy uses the team default. */
export function forkable(c: Ctx, definition: AgentDefinition): AgentDefinition {
  if (!isDangerousMode(definition.frontmatter) || mayDangerous(c)) return definition;
  const { approval_mode: _dropped, ...frontmatter } = definition.frontmatter;
  return { ...definition, frontmatter };
}

/** Where a new or existing agent of `scope` lives for this caller. */
export function locationFor(c: Ctx, scope: AgentScope): AgentLocation {
  if (scope === "team") return { scope, teamId: c.get("team").id };
  if (scope === "personal") return { scope, ownerUserId: c.get("user").id };
  return { scope };
}

export type AgentKit = ReturnType<typeof agentKit>;

/** What the agent route groups share: who may see an agent, and the roster and transfer reads. */
export function agentKit(deps: ServerDeps) {
  const db = deps.database.db;

  /** The agent if the caller may see it; null → 404 (no existence oracle). */
  async function visible(c: Ctx): Promise<AgentRecord | null> {
    const id = param(c, "id", agentIdSchema);
    if (!id.success) return null;
    const agent = await findVisibleAgent(
      db,
      { teamId: c.get("team").id, userId: c.get("user").id },
      id.data,
    );
    return agent && agentAccess(actorOf(c), agent).see ? agent : null;
  }

  /** Someone else's personal agent read from a roster (KOBE-571, AR14), or null. */
  async function rosterRead(c: Ctx) {
    const id = param(c, "id", agentIdSchema);
    if (!id.success) return null;
    // `?from=site` (the Site tab's View) shows the site entry's version in effect (KOBE-571).
    const from = c.req.query("from") === "site" ? "site" : "team";
    return rosterDefinitionRead(db, { ...actorOf(c), teamId: c.get("team").id }, id.data, from);
  }

  /**
   * View from a roster (AR14): the version in effect, read-only, with `versionInEffect` on the
   * agent so the editor says what it shows.
   */
  async function rosterView(c: Ctx): Promise<Response | null> {
    const read = await rosterRead(c);
    if (!read) return null;
    return c.json({
      agent: {
        ...agentDetail(read.agent, ROSTER_READ_ACCESS),
        // Read-only: no export of someone else's agent from a View (owner's Orbit export, KOBE-91).
        canExport: false,
        versionInEffect: read.versionInEffect,
      },
      warnings: agentWarnings(read.agent.frontmatter),
    });
  }

  /** The recipient of a pending transfer reads the offered agent's summary with the offer. */
  async function offeredAgent(c: Ctx): Promise<Response> {
    const id = param(c, "id", agentIdSchema);
    const transfer = id.success ? await pendingTransfer(db, id.data) : null;
    if (!transfer || transfer.toUserId !== c.get("user").id) return notFound(c);
    const offered = await findAgent(
      db,
      { scope: "personal", ownerUserId: transfer.fromUserId },
      transfer.agentId,
    );
    if (!offered) return notFound(c);
    return c.json({ agent: agentSummary(offered, NO_ACCESS), transfer });
  }

  return { deps, db, visible, rosterRead, rosterView, offeredAgent };
}
