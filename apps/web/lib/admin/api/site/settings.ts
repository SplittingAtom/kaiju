/** Site console: settings (`/v1/site`, site.settings.manage; turning 2FA off: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface SiteSettings {
  readonly requireTwoFactor: boolean;
  /** Hours audit events keep the client IP and user agent (KOBE-17): 1-8760, default 12. */
  readonly auditPiiRetentionHours?: number;
  /**
   * The Kobe MCP site switch (KOBE-623, spec kobe-admin-mcp §6, KA5): `off` (no Kobe connector),
   * `docs` (docs tools only; the default) or `admin` (docs plus the admin tools each team turns
   * on). Absent from servers that predate it.
   */
  readonly kobeMcpMode?: KobeMcpMode;
  /** Per-person Kobe admin reads per minute (KOBE-814): 1-10000, default 60. Absent on older servers. */
  readonly kobeReadsPerMinute?: number;
  /** Per-person Kobe admin writes per hour (KOBE-814): 1-10000, default 30. Absent on older servers. */
  readonly kobeWritesPerHour?: number;
}

/** Bounds and defaults of the Kobe admin limits (the server validates them again). */
export const KOBE_LIMITS = {
  min: 1,
  max: 10_000,
  readsDefault: 60,
  writesDefault: 30,
} as const;

export type KobeMcpMode = "off" | "docs" | "admin";

export const KOBE_MCP_MODE_LABELS: Readonly<Record<KobeMcpMode, string>> = {
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
