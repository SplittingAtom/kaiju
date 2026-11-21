import { z } from "zod";
import { UI_RESOURCE_FAILURES } from "../../connectors/ui-resources.js";
import { UI_RESOURCE_PLACEMENTS } from "../../schema/connector-ui-resources.js";
import { event, id, uiUri, type AuditEventDef } from "./fragments.js";

export const CONNECTORS_EVENTS = {
  // ── connectors: the site registry (KOBE-100); ids, names and field names, never URLs or credentials ──
  /** A site admin registered an MCP server. */
  "mcp.connector.registered": event("site", {
    connectorId: id,
    name: z.string().max(64),
    authKind: z.enum(["none", "api_key", "oauth"]),
  }),
  /** A site admin edited a connector; `changed` names the fields, values are not recorded. */
  "mcp.connector.updated": event("site", {
    connectorId: id,
    name: z.string().max(64),
    changed: z
      .array(z.enum(["name", "url", "iconUrl", "authKind", "status", "credentialSource"]))
      .max(6),
  }),
  /** A site admin removed a connector; `soft` when teams still used it (kept disabled). */
  "mcp.connector.removed": event("site", {
    connectorId: id,
    name: z.string().max(64),
    soft: z.boolean(),
    teams: z.number().int().nonnegative(),
    /** KOBE-454: whether a sealed site key was destroyed with it, and how many member grants. */
    siteKeyDropped: z.boolean().optional(),
    grants: z.number().int().nonnegative().optional(),
  }),
  /**
   * Kobe probed a connector and pinned its tools (KOBE-101); the hash covers all pinned tools.
   * `templates`: the MCP Apps `ui://` templates pinned with them and Kobe's SHA-256 of each
   * (KOBE-433); URIs and hashes only, never the template.
   */
  "mcp.connector.pinned": event("site", {
    connectorId: id,
    name: z.string().max(64),
    tools: z.number().int().nonnegative(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    templates: z
      .array(z.strictObject({ uri: uiUri, sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
      .max(64)
      .optional(),
  }),
  // ── connectors: team enablement (KOBE-104); names and Pi tool names, never URLs or credentials ──
  /** A team admin enabled a connector for the team, changed its exposure or tick list, or disabled it. */
  "mcp.connector.team_changed": event("team", {
    connectorId: id,
    name: z.string().max(64),
    change: z.enum(["enabled", "exposure_changed", "disabled"]),
    exposure: z.enum(["read_only", "all", "custom"]).optional(),
    /** The custom tick list (Pi tool names); empty unless exposure is custom. */
    tools: z.array(z.string().max(256)).max(1000).optional(),
  }),
  /**
   * The periodic refresh found a connector's live tools differ from its pins (KOBE-102): `changed`
   * and `added` tools are now disabled pending re-approval, `removed` ones are no longer offered.
   * Tool names only, never descriptions or schemas. Written by the system actor; KOBE-103 reads it.
   * `templates` (KOBE-433): the same for the connector's MCP Apps `ui://` templates, by URI, and
   * `invalid`: live templates that cannot be pinned, with the failure code.
   */
  "mcp.connector.drift": event("site", {
    connectorId: id,
    name: z.string().max(64),
    changed: z.array(z.string().max(128)).max(500),
    added: z.array(z.string().max(128)).max(500),
    removed: z.array(z.string().max(128)).max(500),
    templates: z
      .strictObject({
        changed: z.array(uiUri).max(64),
        added: z.array(uiUri).max(64),
        removed: z.array(uiUri).max(64),
        /** Live templates that cannot be pinned (newly so), with the reason (review HIGH-2). */
        invalid: z
          .array(z.strictObject({ uri: uiUri, reason: z.enum(UI_RESOURCE_FAILURES) }))
          .max(64)
          .optional(),
      })
      .optional(),
  }),
  /**
   * A recipient was handled for one drift event (KOBE-103): `driftSeq` is the `mcp.connector.drift`
   * row. `emailed: false` when the per-connector, per-recipient rate limit suppressed the email.
   * Ids and counts only: no address, no tool names. Also the dedupe and rate-limit record.
   */
  "mcp.connector.drift_notified": event("site", {
    connectorId: id,
    driftSeq: z.number().int().positive(),
    recipientId: id,
    emailed: z.boolean(),
    /** KOBE-431: `skipped` for a refresh-skip event (rate-limited apart from drift); absent = drift. */
    kind: z.enum(["drift", "skipped", "templates_skipped"]).optional(),
  }),
  /** A site admin re-approved drifted tools (KOBE-102); they are offered again. */
  "mcp.connector.reapproved": event("site", {
    connectorId: id,
    name: z.string().max(64),
    tools: z.array(z.string().max(128)).max(500),
    /** MCP Apps templates approved (KOBE-434): URI and Kobe's SHA-256 of the approved bytes. */
    templates: z
      .array(z.strictObject({ uri: uiUri, sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
      .max(64)
      .optional(),
  }),
  /**
   * A site admin set where a pinned template's app opens (KOBE-531, MA3 as amended 2026-10-31):
   * the previous and the new placement. Not part of the pin; recorded only when it changes.
   */
  "mcp.connector.template_placement_set": event("site", {
    connectorId: id,
    name: z.string().max(64),
    uri: uiUri,
    previous: z.enum(UI_RESOURCE_PLACEMENTS),
    placement: z.enum(UI_RESOURCE_PLACEMENTS),
  }),
  /**
   * Which credential probes a connector's `tools/list` (KOBE-431): the connector's site-wide key
   * (KOBE-303), the own key of the site admin `adminId`, or none. Never a member's key, never the
   * value. Recorded on every pin by an admin, and by the periodic refresh when its choice changes.
   */
  "mcp.connector.probe_credential": event("site", {
    connectorId: id,
    name: z.string().max(64),
    purpose: z.enum(["pin", "refresh"]),
    credential: z.enum(["site_key", "admin_key", "none"]),
    adminId: id.optional(),
  }),
  /**
   * The periodic refresh started skipping a connector because it asked for credentials and no
   * usable site key or admin key exists (KOBE-431); site admins are told. System actor; written
   * when the skip begins, not on every pass.
   */
  "mcp.connector.refresh_skipped": event("site", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["auth_required"]),
  }),
  /**
   * A site admin re-probed a connector now (KOBE-430, the Re-probe button): the periodic
   * refresh's probe and drift for one connector, or the pin path for one without pins. Counts,
   * the outcome and the credential's kind only: never tool names, the URL or a key.
   */
  "mcp.connector.refreshed": event("site", {
    connectorId: id,
    name: z.string().max(64),
    outcome: z.enum(["unchanged", "drifted", "pinned", "failed"]),
    reason: z
      .string()
      .regex(/^[a-z_]{1,32}$/)
      .optional(),
    changed: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    credential: z.enum(["site_key", "admin_key", "none"]).optional(),
    adminId: id.optional(),
  }),
  /**
   * The refresh began not checking a connector's MCP Apps templates while its tools were checked
   * (KOBE-433 re-review NEW-2): `resources/list` failed, an outdated proxy, a failed write. Site
   * admins are told; only approved bytes are ever served meanwhile.
   */
  "mcp.connector.templates_skipped": event("site", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.string().regex(/^[a-z_]{1,32}$/),
  }),
  /** A site admin set or replaced a connector's site-wide API key (KOBE-303); never the key or its hint. */
  "mcp.connector.site_key_set": event("site", {
    connectorId: id,
    name: z.string().max(64),
    replaced: z.boolean(),
  }),
  /**
   * A connector's site-wide API key was removed (KOBE-303): by an admin, by a change of URL or
   * mode, or with the connector itself (KOBE-454).
   */
  "mcp.connector.site_key_removed": event("site", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["removed", "url_changed", "mode_changed", "connector_removed"]),
  }),
} as const satisfies Record<string, AuditEventDef>;
