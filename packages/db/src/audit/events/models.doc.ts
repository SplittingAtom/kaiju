import type { AuditEventDoc } from "./fragments.js";
import type { MODELS_EVENTS } from "./models.js";

/**
 * The docs/audit-log.md rows of the models area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const MODELS_EVENT_DOCS = {
  "models.budget.changed": {
    fields:
      "`scope` (install, team, user), `userId?`, `monthlyUsd`, `dailyUsd`, `monthlyVolume?`, `dailyVolume?` (token budgets), `memberDefault?`, `requestsPerMinute?`, `removed?`",
    when: "A dollar or token budget, or the per-user request rate, was set, changed or removed (KOBE-42): site admins for the install, team admins for the team or a member",
  },
  "models.budget.reached": {
    fields:
      "`scope`, `userId?`, `period` (month, day), `periodStart`, `unit` (usd, tokens), `limit`, `spent`",
    when: "A budget was used up (actor: system; once per budget and period): new model calls and runs are refused at its level and active runs end after their current step (D30)",
  },
  "models.catalog.changed": {
    fields:
      "`alias`, `change` (added, updated, removed), `providerId?`, `model?`, `pricesChanged?` (KOBE-43)",
    when: "A catalog alias was added, re-pointed, re-priced or removed (removal also disables it for every team)",
  },
  "models.followups.changed": {
    fields: "`enabled`",
    when: "A team admin turned post-run follow-up suggestions on or off for the team (KOBE-222, CE21)",
  },
  "models.provider.added": {
    fields: "`providerId`, `kind`, `keySet`, `privateNetwork`, `endpointHost`",
    when: "A site admin added a model provider (KOBE-40); never the API key",
  },
  "models.provider.changed": {
    fields:
      "`providerId`, `kind`, `keyChanged`, `baseUrlChanged`, `privateNetwork`, `endpointHost` (where the key is sent)",
    when: "A provider's name, endpoint, private-network flag or API key changed (the key itself is never recorded)",
  },
  "models.provider.models_refreshed": {
    fields: "`providerId`, `kind`, `outcome` (ok, failed, unavailable), `models` (count)",
    when: "A site admin asked the gateway to list a provider's models with its stored key (KOBE-44 model picker); never the provider's answer or the key",
  },
  "models.provider.removed": {
    fields: "`providerId`, `kind`",
    when: "A provider without catalog models was removed",
  },
  "models.team.changed": {
    fields: "`alias`, `enabled`, `isDefault`",
    when: "A team admin enabled or disabled a catalog model for the team, or changed its default",
  },
  "team.default_agent_changed": {
    fields: "`agentId` (null: the site default), `previousAgentId`",
    when: "A team admin chose the team's default agent for new conversations from its roster, or went back to the site default (KOBE-571)",
  },
} satisfies Record<keyof typeof MODELS_EVENTS, AuditEventDoc>;
