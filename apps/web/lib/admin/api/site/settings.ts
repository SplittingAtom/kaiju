/** Site console: settings (`/v1/site`, site.settings.manage; turning 2FA off: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface SiteSettings {
  readonly requireTwoFactor: boolean;
  /** Hours audit events keep the client IP and user agent (KOBE-17): 1-8760, default 12. */
  readonly auditPiiRetentionHours?: number;
  /**
   * The Kaiju MCP site switch (KOBE-623, spec kobe-admin-mcp §6, KA5): `off` (no Kaiju connector),
   * `docs` (docs tools only; the default) or `admin` (docs plus the admin tools each team turns
   * on). Absent from servers that predate it.
   */
  readonly kobeMcpMode?: KaijuMcpMode;
  /** Per-person Kaiju admin reads per minute (KOBE-814): 1-10000, default 60. Absent on older servers. */
  readonly kobeReadsPerMinute?: number;
  /** Per-person Kaiju admin writes per hour (KOBE-814): 1-10000, default 30. Absent on older servers. */
  readonly kobeWritesPerHour?: number;
  /** Workspace git (KOBE-757, spec G3): Git connections allowed on this Site (default true). */
  readonly gitConnectionsEnabled?: boolean;
  /** Hosts Workspaces may connect to (`github.com`, `*.example.com`); empty = any host. */
  readonly gitAllowedHosts?: readonly string[];
}

/** Bounds and defaults of the Kaiju admin limits (the server validates them again). */
export const KAIJU_LIMITS = {
  min: 1,
  max: 10_000,
  readsDefault: 60,
  writesDefault: 30,
} as const;

export type KaijuMcpMode = "off" | "docs" | "admin";

export const KAIJU_MCP_MODE_LABELS: Readonly<Record<KaijuMcpMode, string>> = {
  off: "Off",
  docs: "Docs only",
  admin: "Docs and admin tools",
};

/** Bounds of `auditPiiRetentionHours` (the server validates them again). */
export const AUDIT_PII_RETENTION_HOURS = { min: 1, max: 8760, default: 12 } as const;

/** Sends only the settings given; each change is audited. */
export function putSiteSettings(change: Partial<SiteSettings>): Promise<ApiResult<SiteSettings>> {
  return apiRequest("/v1/site/settings", { method: "PUT", json: { ...change } });
}

export function getSiteSettings(): Promise<ApiResult<SiteSettings>> {
  return apiRequest("/v1/site/settings");
}
