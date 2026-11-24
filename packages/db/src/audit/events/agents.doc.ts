import type { AuditEventDoc } from "./fragments.js";
import type { AGENTS_EVENTS } from "./agents.js";

/**
 * The docs/audit-log.md rows of the agents area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const AGENTS_EVENT_DOCS = {
  "agent.adopted": {
    fields:
      "`agentId` (the new agent), `scope` (team, gallery), `slug`, `roster` (team, site), `fromAgentId`, `fromVersion`",
    when: "A team admin (team roster) or site admin (site roster) copied the entry's published version into a team-owned or site-owned agent; the entry is removed (`agent.roster.removed`)",
  },
  "agent.archived": {
    fields: "`agentId`, `scope`, `slug`",
    when: "A published agent deleted: archived instead, its versions stay pinned",
  },
  "agent.created": {
    fields:
      "`agentId`, `scope`, `slug`, `source` (json, import, fork, seed, adopt), `forkedFrom?`, `forkedFromVersion?`, `boundTeamId?` (fork: the team a fork of team content is bound to, or null; KOBE-568)",
    when: "Agent created, imported from a file, forked (always a personal agent since KOBE-568), or adopted",
  },
  "agent.customized": {
    fields: "`agentId`, `scope` (gallery), `slug`, `fromGeneration`",
    when: "A site admin's first draft save or publish of a seeded gallery agent detached it from the repository definition; the seed skips it from now on (KOBE-494)",
  },
  "agent.dangerous_mode.changed": {
    fields: "`agentId`, `scope`, `slug`, `enabled`",
    when: "A create, import, draft update or fork turned the admin-only Dangerous approval mode on or off (AC1, KOBE-476)",
  },
  "agent.deleted": {
    fields: "`agentId`, `scope`, `slug`",
    when: "Never-published agent deleted (a published one is archived)",
  },
  "agent.eval.finished": {
    fields:
      "`agentId`, `scope`, `slug`, `evalId`, `status` (passed, blocked, errored), `attackSuccessRate`",
    when: "The eval ended: passed (then published), blocked above the threshold, or errored (fail closed)",
  },
  "agent.eval.requested": {
    fields: "`agentId`, `scope`, `slug`, `evalId`, `draftRevision`",
    when: "Publish ran the Orbit eval first because the team's gate is on (KOBE-93)",
  },
  "agent.eval.settings_changed": {
    fields: "`enabled`, `maxAttackSuccessRate`",
    when: "A team admin changed the eval gate switch or its threshold (KOBE-93)",
  },
  "agent.eval_case.reviewed": {
    fields: "`agentId`, `scope`, `caseId`, `status` (open, accepted, dismissed)",
    when: "The agent's owner reviewed a shared eval case (KOBE-276); never its text or who shared it",
  },
  "agent.exported": { fields: "`agentId`, `scope`, `slug`", when: "Agent file downloaded" },
  "agent.memory_changed": {
    fields: "`agentId`, `scope`, `slug`, `version`, `fromVersion`, `memory`",
    when: "The memory setting changed (KOBE-646): the current version republished as a new version with `memory` = `all`, `notes_only` or `off`",
  },
  "agent.orbit_exported": {
    fields: "`agentId`, `scope`, `slug`, `version`",
    when: "Published version downloaded as Orbit YAML (KOBE-91)",
  },
  "agent.published": {
    fields: "`agentId`, `scope`, `slug`, `version`, `draftRevision`",
    when: "Draft published as a new immutable version with a frozen tool manifest (D19)",
  },
  "agent.reset_to_repository": {
    fields: "`agentId`, `scope` (gallery), `slug`, `fromGeneration`",
    when: "A site admin reset a customized gallery agent to the repository definition; the seed publishes that definition as a new version (KOBE-494)",
  },
  "agent.rolled_back": {
    fields: "`agentId`, `scope`, `slug`, `version`, `fromVersion`",
    when: "An older version republished as the new current version",
  },
  "agent.roster.approved": {
    fields:
      "`agentId`, `scope`, `slug`, `roster` (team, site), `versionRule` (latest, pinned), `pinnedVersion`",
    when: "A team or site admin approved a proposal",
  },
  "agent.roster.assigned": {
    fields:
      "`agentId`, `scope`, `slug`, `roster` (team, site), `versionRule` (latest, pinned), `pinnedVersion`",
    when: "A personal agent put on the team roster directly (by its owner with `team.agents.build`, or by a Contributor adding someone else's site-assigned agent) or on the site roster (by its owner, a site admin) (KOBE-566)",
  },
  "agent.roster.declined": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "A team or site admin declined a proposal (the note is not recorded)",
  },
  "agent.roster.pinned": {
    fields:
      "`agentId`, `scope`, `slug`, `roster` (team, site), `versionRule` (latest, pinned), `pinnedVersion`",
    when: "An admin pinned a roster entry to a published version",
  },
  "agent.roster.proposed": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "A member proposed their agent to the team or site roster",
  },
  "agent.roster.removed": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "An admin removed an entry from the roster, or adopted it (followed by `agent.adopted`); the row stays as `removed`",
  },
  "agent.roster.resumed": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "A roster suspension (`agent.roster.suspended`) was lifted",
  },
  "agent.roster.suspended": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "Team roster: a team admin suspended a team entry, site entry or gallery agent for the team (its `team_agent_suspensions` row; the entry stays active); site roster: suspended site-wide. Team-owned agents and the Inventory API log `agent.status_changed`",
  },
  "agent.roster.updated": {
    fields:
      "`agentId`, `scope`, `slug`, `roster` (team, site), `versionRule` (latest, pinned), `pinnedVersion`",
    when: "An admin moved a pinned entry to another version or back to latest",
  },
  "agent.roster.withdrawn": {
    fields: "`agentId`, `scope`, `slug`, `roster` (team, site)",
    when: "The owner withdrew their agent or proposal from a roster",
  },
  "agent.status_changed": {
    fields: "`agentId`, `scope`, `slug`, `status`",
    when: "Suspended or reactivated",
  },
  "agent.transfer.cancelled": {
    fields: "`agentId`, `scope`, `slug`, `fromUserId`, `toUserId`, `by` (owner, recipient)",
    when: "A pending transfer cancelled by the owner or declined by the recipient",
  },
  "agent.transfer.requested": {
    fields: "`agentId`, `scope`, `slug`, `fromUserId`, `toUserId`",
    when: "The owner offered their personal agent to another member of the team (`teamId` = that team; KOBE-568)",
  },
  "agent.transferred": {
    fields: "`agentId`, `scope`, `slug`, `fromUserId`, `toUserId`",
    when: "The recipient accepted: the agent, its roster entries and thread pins now belong to them (same agent id)",
  },
  "agent.unarchived": { fields: "`agentId`, `scope`, `slug`", when: "Archived agent restored" },
  "agent.updated": {
    fields: "`agentId`, `scope`, `slug`, `revision`, `source` (json, import, seed)",
    when: "Draft replaced",
  },
} satisfies Record<keyof typeof AGENTS_EVENTS, AuditEventDoc>;
