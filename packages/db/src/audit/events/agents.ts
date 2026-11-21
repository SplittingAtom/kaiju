import { z } from "zod";
import { AGENT_VERSION_MEMORY_SETTINGS } from "../../schema/agents.js";
import {
  agentRef,
  event,
  id,
  rosterRef,
  version,
  versionRuleRef,
  type AuditEventDef,
} from "./fragments.js";

export const AGENTS_EVENTS = {
  // ── agent: definitions (D19); team agents in the team view, personal and gallery site-only ──
  "agent.created": event("any", {
    ...agentRef,
    // "seed": a gallery agent created from the repo's definitions at install or upgrade (KOBE-87).
    // "adopt": a team or site admin adopted a roster entry's agent (KOBE-568, agents-roster AR10).
    source: z.enum(["json", "import", "fork", "seed", "adopt"]),
    forkedFrom: id.optional(),
    forkedFromVersion: version.optional(),
    /** A fork's binding (KOBE-568, AR8): the team a fork of team content stays in, or null. */
    boundTeamId: id.nullable().optional(),
  }),
  "agent.updated": event("any", {
    ...agentRef,
    revision: z.number().int().positive(),
    source: z.enum(["json", "import", "seed"]),
  }),
  "agent.deleted": event("any", agentRef),
  /** A create, import, draft update or fork turned Dangerous mode (AC1, KOBE-476) on or off. */
  "agent.dangerous_mode.changed": event("any", { ...agentRef, enabled: z.boolean() }),
  "agent.status_changed": event("any", { ...agentRef, status: z.enum(["active", "suspended"]) }),
  "agent.exported": event("any", agentRef),
  /** A published version exported as Orbit YAML (KOBE-91). */
  "agent.orbit_exported": event("any", { ...agentRef, version }),
  // Versions (KOBE-46): publish freezes the draft and its tool manifest; rollback republishes.
  "agent.published": event("any", { ...agentRef, version, draftRevision: version }),
  "agent.rolled_back": event("any", { ...agentRef, version, fromVersion: version }),
  /** The memory setting changed (KOBE-646): the current version republished with `memory`. */
  "agent.memory_changed": event("any", {
    ...agentRef,
    version,
    fromVersion: version,
    memory: z.enum(AGENT_VERSION_MEMORY_SETTINGS),
  }),
  /**
   * A site admin's first edit of a seeded gallery agent (KOBE-494) detached it from the repo's
   * definition: `fromGeneration` is the repo generation it was edited from.
   */
  "agent.customized": event("site", { ...agentRef, fromGeneration: version }),
  /** A site admin re-attached a customized gallery agent to the repo's definition (KOBE-494). */
  "agent.reset_to_repository": event("site", { ...agentRef, fromGeneration: version }),
  // The pre-publish Orbit eval gate (KOBE-93): requested at Publish, finished with a verdict.
  "agent.eval.requested": event("team", { ...agentRef, evalId: id, draftRevision: version }),
  "agent.eval.finished": event("team", {
    ...agentRef,
    evalId: id,
    status: z.enum(["passed", "blocked", "errored"]),
    attackSuccessRate: z.number().min(0).max(1).nullable(),
  }),
  /**
   * The agent's owner reviewed a shared eval case (KOBE-276): its id and new status only, never
   * its text or who shared it.
   */
  "agent.eval_case.reviewed": event("team", {
    agentId: id,
    scope: z.enum(["team", "personal"]),
    caseId: id,
    status: z.enum(["open", "accepted", "dismissed"]),
  }),
  /** A team admin changed the eval gate switch or its attack-success-rate ceiling (KOBE-93). */
  "agent.eval.settings_changed": event("team", {
    enabled: z.boolean(),
    maxAttackSuccessRate: z.number().min(0).max(1),
  }),
  /** An agent with versions retired instead of deleted (pinned threads keep their version). */
  "agent.archived": event("any", agentRef),
  "agent.unarchived": event("any", agentRef),
  // Rosters (KOBE-566, agents-roster §6.9): a personal agent lent to a team or the site by
  // reference. Team entries in the team view (`teamId` = the roster's team), site entries
  // site-only. Ids, slug, scope, roster and version rule only; never a definition or a note.
  "agent.roster.assigned": event("any", { ...rosterRef, ...versionRuleRef }),
  "agent.roster.proposed": event("any", rosterRef),
  "agent.roster.approved": event("any", { ...rosterRef, ...versionRuleRef }),
  "agent.roster.declined": event("any", rosterRef),
  /** An admin pinned a following entry to a version (AR5). */
  "agent.roster.pinned": event("any", { ...rosterRef, ...versionRuleRef }),
  /** An admin moved a pinned entry: to another version or back to latest (AR5 "Update"). */
  "agent.roster.updated": event("any", { ...rosterRef, ...versionRuleRef }),
  "agent.roster.removed": event("any", rosterRef),
  /** The owner withdrew their agent (or their proposal) from a roster (AR7). */
  "agent.roster.withdrawn": event("any", rosterRef),
  /** Team roster: suspended for that team; site roster: suspended site-wide (§6.5). */
  "agent.roster.suspended": event("any", rosterRef),
  "agent.roster.resumed": event("any", rosterRef),
  // Transfer and adopt (KOBE-568, agents-roster AR10, §6.9): ids only. A transfer belongs to the
  // team both members were in when it was offered (`teamId`); adopting into the site is site-only.
  /** The owner offered their personal agent to another member of the team. */
  "agent.transfer.requested": event("any", { ...agentRef, fromUserId: id, toUserId: id }),
  /** The owner cancelled the offer, or the recipient declined it. */
  "agent.transfer.cancelled": event("any", {
    ...agentRef,
    fromUserId: id,
    toUserId: id,
    by: z.enum(["owner", "recipient"]),
  }),
  /** The recipient accepted: the agent and its roster entries now belong to them. */
  "agent.transferred": event("any", { ...agentRef, fromUserId: id, toUserId: id }),
  /**
   * An admin copied a roster entry's agent (`fromAgentId` at `fromVersion`) into a new team-owned
   * (team roster) or site-owned gallery (site roster) agent, named by `agentId`; the entry is removed.
   */
  "agent.adopted": event("any", {
    ...agentRef,
    roster: z.enum(["team", "site"]),
    fromAgentId: id,
    fromVersion: version,
  }),
} as const satisfies Record<string, AuditEventDef>;
