import type { AuditEventDoc } from "./fragments.js";
import type { EGRESS_EVENTS } from "./egress.js";

/**
 * The docs/audit-log.md rows of the egress area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const EGRESS_EVENT_DOCS = {
  "egress.ceiling.added": {
    fields: "`domain`",
    when: "Custom domain added to the egress ceiling (KOBE-38)",
  },
  "egress.ceiling.changed": {
    fields: "`domain`, `inCeiling`",
    when: "A preset or custom domain put into or taken out of the ceiling",
  },
  "egress.ceiling.internal_changed": {
    fields: "`domain`, `internal`",
    when: "A site admin marked a ceiling pattern internal (same cluster: its hosts may reach the site's internal targets) or cleared it (KOBE-602, EA4)",
  },
  "egress.ceiling.removed": {
    fields: "`domain`",
    when: "Custom domain deleted; every team's enablement of it went with it",
  },
  "egress.connection": {
    fields:
      "`userId`, `sandboxId`, `domain?`, `port?`, `outcome`, `reason?`, `aggregated?`, `upgraded?`, `repository?`, `gitService?` (upload-pack, receive-pack), `connections`, `bytesUp`, `bytesDown`, `from`, `to`",
    when: "Sandbox connections through the egress proxy, aggregated per key and window (system; see below); git fetches and pushes to a connected organization carry the repository and service (KOBE-763)",
  },
  "egress.domain.disabled": {
    fields: "`domain`, `headersRemoved?`",
    when: "Team admin disabled it",
  },
  "egress.domain.enabled": {
    fields: "`domain`",
    when: "Team admin enabled a ceiling domain for the team's sandboxes",
  },
  "egress.git_push": {
    fields:
      "`userId`, `sandboxId`, `connectionId?`, `domain`, `repository`, `outcome`, `reason?`, `refs?` (`ref`, `change`: create, update, delete), `refsTruncated?`, `status?`, `bytesUp`",
    when: "A git push from a sandbox through the egress proxy to a connected organization, allowed or refused (`reason`: the server's decision code or the proxy's); refs read from the push's command list, never the pack; never a credential (system; KOBE-763)",
  },
  "egress.header.cleared": {
    fields: "`domain`",
    when: "Team admin removed a domain's injected headers",
  },
  "egress.header.set": {
    fields: "`domain`, `headerNames`",
    when: "Team admin set or replaced the injected headers of an enabled domain (KOBE-39): names only, never values",
  },
  "egress.request.created": {
    fields:
      "`requestId`, `domain`, `pattern`, `threadId?`, `notified`, `scope?` (team, site), `internal?`",
    when: "A member asked to enable a blocked domain (KOBE-39); `scope` team: the team's admins decide, site: outside the ceiling or an internal address, the site admins decide (KOBE-602); thread id only, never a URL or prompt",
  },
  "egress.request.decided": {
    fields:
      "`requestId`, `pattern`, `requested?`, `decision` (approved, denied), `requests`, `enabled`, `by?` (team_admin, site_admin), `internal?`",
    when: "A team or site admin approved (enabling the pattern; a site admin also adds it to the ceiling, `requested` naming the request's own pattern when another was chosen) or denied a request; every pending request the pattern covers is settled (KOBE-602)",
  },
  "egress.site_connection": {
    fields:
      "`job`, `domain?`, `port?`, `outcome`, `reason?`, `aggregated?`, `connections`, `bytesUp`, `bytesDown`, `from`, `to`",
    when: "The server's own site-job connections through the egress proxy (`skill-mirror`: the catalog's git mirror; `skill-import`: governed imports), aggregated like `egress.connection`; never a token (system; KOBE-343)",
  },
} satisfies Record<keyof typeof EGRESS_EVENTS, AuditEventDoc>;
