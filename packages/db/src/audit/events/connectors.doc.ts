import type { AuditEventDoc } from "./fragments.js";
import type { CONNECTORS_EVENTS } from "./connectors.js";

/**
 * The docs/audit-log.md rows of the connectors area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in name order.
 */
export const CONNECTORS_EVENT_DOCS = {
  "mcp.connector.drift": {
    fields:
      "`connectorId`, `name`, `changed`, `added`, `removed` (tool names only), `templates` (`changed`, `added`, `removed` URIs; `invalid` URI and reason, KOBE-433)",
    when: "The periodic refresh found live tools differing from the pins (KOBE-102): changed and new tools are disabled until re-approved, removed ones are no longer offered. System actor",
  },
  "mcp.connector.drift_notified": {
    fields:
      "`connectorId`, `driftSeq`, `recipientId`, `emailed`, `kind?` (drift, skipped; KOBE-431)",
    when: "A recipient was handled for one drift event (KOBE-103); `emailed` is false when the per-connector, per-recipient rate limit suppressed the email. Dedupe and rate-limit record. System actor",
  },
  "mcp.connector.pinned": {
    fields: "`connectorId`, `name`, `tools`, `hash`, `templates` (ui:// URI and SHA-256, KOBE-433)",
    when: "Kaiju probed a connector's `tools/list` and pinned every tool (SHA-256 over name, description, input schema; KOBE-101)",
  },
  "mcp.connector.probe_credential": {
    fields:
      "`connectorId`, `name`, `purpose` (pin, refresh), `credential` (site_key, admin_key, admin_oauth, none), `adminId?`",
    when: "Which credential probed a connector's `tools/list` (KOBE-431): its site-wide key, the own key of site admin `adminId`, that admin's own OAuth access token (`admin_oauth`, KOBE-784), or none; never a member's key, never the value. Every pin by an admin; the periodic refresh only when its choice changes",
  },
  "mcp.connector.reapproved": {
    fields: "`connectorId`, `name`, `tools`, `templates` (URI and SHA-256, KOBE-434)",
    when: "A site admin re-approved drifted tools (KOBE-102)",
  },
  "mcp.connector.refresh_skipped": {
    fields: "`connectorId`, `name`, `reason` (auth_required)",
    when: "The periodic refresh began skipping a connector that asks for credentials with no usable site key or admin key (KOBE-431); site admins are emailed and see it on the connector page. System actor",
  },
  "mcp.connector.refreshed": {
    fields:
      "`connectorId`, `name`, `outcome` (unchanged, drifted, pinned, failed), `reason?` (failure code), `changed`, `added`, `removed` (counts), `credential?` (site_key, admin_key, admin_oauth, none), `adminId?`",
    when: "A site admin re-probed a connector now with the Re-probe button (KOBE-430): the periodic refresh's probe and drift for one connector, or the pin path when it had no pins. Counts only; never tool names, the URL or a key",
  },
  "mcp.connector.registered": {
    fields: "`connectorId`, `name`, `authKind`",
    when: "A site admin registered an MCP server (KOBE-100); the URL is not recorded",
  },
  "mcp.connector.removed": {
    fields: "`connectorId`, `name`, `soft`, `teams`, `siteKeyDropped`, `grants`",
    when: "A connector was removed; `soft` when teams still used it so it stays disabled (KOBE-100); its site key and member grants are destroyed with it (KOBE-454)",
  },
  "mcp.connector.site_key_removed": {
    fields:
      "`connectorId`, `name`, `reason` (removed, url_changed, mode_changed, connector_removed)",
    when: "A connector's site-wide API key was removed by an admin, or dropped because its URL or credential mode changed (KOBE-303) or the connector was removed (KOBE-454)",
  },
  "mcp.connector.site_key_set": {
    fields: "`connectorId`, `name`, `replaced`",
    when: "A site admin set or replaced a connector's site-wide API key (KOBE-303); never the key or its hint",
  },
  "mcp.connector.team_changed": {
    fields:
      "`connectorId`, `name`, `change` (enabled, exposure_changed, disabled), `exposure?` (read_only, all, custom), `tools?` (the custom tick list, Pi tool names)",
    when: "A team admin enabled a connector for the team, changed its exposure or tick list, or disabled it (KOBE-104); no event when nothing changed; never URLs or credentials",
  },
  "mcp.connector.template_placement_set": {
    fields: "`connectorId`, `name`, `uri`, `previous`, `placement`",
    when: "A site admin set where a pinned MCP Apps template opens (`chat`, `artifacts` or `rail`, KOBE-531); recorded only on a change",
  },
  "mcp.connector.templates_skipped": {
    fields: "`connectorId`, `name`, `reason`",
    when: "The refresh began not checking a connector's MCP Apps templates while its tools were checked (KOBE-433): resources/list failed, an outdated proxy, a failed write. Site admins are emailed and see it on the connector page. System actor",
  },
  "mcp.connector.updated": {
    fields:
      "`connectorId`, `name`, `changed` (name, url, iconUrl, authKind, status, credentialSource)",
    when: "A connector was edited; `changed` lists field names only (KOBE-100)",
  },
} satisfies Record<keyof typeof CONNECTORS_EVENTS, AuditEventDoc>;
