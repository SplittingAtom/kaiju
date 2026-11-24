import type { AuditEventDoc } from "./fragments.js";
import type { CONNECTOR_GRANTS_EVENTS } from "./connector-grants.js";

/**
 * The docs/audit-log.md rows of the connector-grants area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const CONNECTOR_GRANTS_EVENT_DOCS = {
  "mcp.grant.added": {
    fields: "`connectorId`, `name`",
    when: "A user added their own API key for a connector their team enabled (KOBE-108). The key and its hint are never recorded",
  },
  "mcp.grant.refresh_failed": {
    fields: "`connectorId`, `name`, `reason` (`rejected`, `no_refresh_token`)",
    when: "An OAuth token refresh failed for good; the grant was dropped and the user must reconnect (KOBE-110). Never records a token",
  },
  "mcp.grant.refused": {
    fields: "`connectorId`, `name`, `reason`",
    when: "A stored OAuth token was not served because it was issued for a different server than the connector's current URL (KOBE-109), or the user is deactivated or no longer a member (`user_inactive`, KOBE-110). Never records the token",
  },
  "mcp.grant.removed": {
    fields:
      "`connectorId`, `name`, `userId`?, `reason`? (member_removed, deactivated, deprovisioned, reactivated)",
    when: "A user's grant for a connector was removed: by the user (KOBE-108), or dropped by a URL/mode change or the connector's removal (KOBE-454), or because the member left (KOBE-696: removed from the team, deactivated, or deprovisioned by the identity provider; also the offboarding sweep's cleanup, actor system; `reactivated`: keys a failed deactivation step left, deleted on reactivation)",
  },
  "mcp.grant.replaced": {
    fields: "`connectorId`, `name`",
    when: "A user replaced their API key for a connector (KOBE-108)",
  },
  "mcp.kobe.team_level_changed": {
    fields: "`from`, `to` (docs, read, read_write)",
    when: "A team admin changed the team's level of the built-in Kaiju connector in Team console › Connectors (KOBE-623); no event when nothing changed",
  },
  "mcp.web_search.configured": {
    fields: "`provider`, `enabled`, `keyChanged`",
    when: "A site admin set the web search provider, its switch, or replaced its key (KOBE-113). The key and its hint are never recorded. Retired by KOBE-606 (built-in web search removed): no longer written; older rows stay",
  },
  "mcp.web_search.removed": {
    fields: "`provider`",
    when: "A site admin removed the web search provider and key (KOBE-113). Retired by KOBE-606 (built-in web search removed): no longer written; older rows stay",
  },
  "mcp.web_search.team_changed": {
    fields: "`enabled`",
    when: "A team admin turned web search on or off for the team (KOBE-113). Retired by KOBE-606 (built-in web search removed): no longer written; older rows stay",
  },
} satisfies Record<keyof typeof CONNECTOR_GRANTS_EVENTS, AuditEventDoc>;
