import { z } from "zod";
import { event, id, type AuditEventDef } from "./fragments.js";

export const CONNECTOR_GRANTS_EVENTS = {
  // ── connector grants (KOBE-108): a user's own API key; ids and names only, never the key or its hint ──
  /** A user added their API key for a connector their team enabled. */
  "mcp.grant.added": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A user replaced their API key for a connector. */
  "mcp.grant.replaced": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A user removed their API key for a connector. */
  "mcp.grant.removed": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A stored OAuth token was not served because it was issued for another server (KOBE-109). */
  "mcp.grant.refused": event("team", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["resource_mismatch", "user_inactive"]),
  }),
  /** An OAuth refresh failed for good (KOBE-110): the grant was dropped and the user must reconnect. */
  "mcp.grant.refresh_failed": event("team", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["rejected", "no_refresh_token"]),
  }),
  // ── web search (KOBE-113): provider and switches only, never the key or its hint ──
  // Retired by KOBE-606 (built-in web search removed; search comes through MCP connectors): none of
  // these is written any more; rows written before it stay and still read.
  /** A site admin set the web search provider, its enabled switch, or replaced its key. */
  "mcp.web_search.configured": event("site", {
    provider: z.enum(["brave", "tavily", "exa"]),
    enabled: z.boolean(),
    keyChanged: z.boolean(),
  }),
  /** A site admin removed the web search provider. */
  "mcp.web_search.removed": event("site", { provider: z.enum(["brave", "tavily", "exa"]) }),
  /** A team admin turned web search on or off for the team. */
  "mcp.web_search.team_changed": event("team", { enabled: z.boolean() }),
  /**
   * A team admin changed the team's level of the built-in Kobe connector (KOBE-623, spec
   * kobe-admin-mcp §6, KA5): `docs` (docs tools only), `read` or `read_write` (admin tools).
   */
  "mcp.kobe.team_level_changed": event("team", {
    from: z.enum(["docs", "read", "read_write"]),
    to: z.enum(["docs", "read", "read_write"]),
  }),
} as const satisfies Record<string, AuditEventDef>;
