import { z } from "zod";

/**
 * The built-in Kaiju MCP connector (KOBE-618/619, spec kobe-admin-mcp §3): its fixed id, the same on
 * every site (`@kaiju/db` `KAIJU_BUILTIN_CONNECTOR_ID`, check-enforced on the row). The MCP proxy
 * routes `POST /v1/mcp/<this id>` to the server's internal listener (`/internal/v1/mcp/kaiju/*`)
 * instead of an upstream server; nothing about it reaches a sandbox but the id.
 */
export const KAIJU_BUILTIN_CONNECTOR_ID = "6b6f6265-0000-4000-8000-000000000001";

/**
 * The path segment `kobe`, served next to `kaiju` for one release (KOBE-826) so that pods of the
 * releases before and after the rename agree during a rolling upgrade: the server's internal
 * listener `/internal/v1/mcp/kobe/*` (which the MCP proxy keeps calling until then), the team API
 * `/v1/team/connectors/kobe` and a catalog skill's `/kobe/compare` and `/kobe/reset`. Removed with
 * the one-release fallbacks in KOBE-754.
 */
export const PRE_RENAME_SEGMENT = "kobe";

/**
 * Names stored before the rename (KOBE-826) with their successors: the audit `setting` values of
 * the Kaiju switches and limits, and the Kaiju admin deny codes. Audit rows, approvals and run
 * events keep them (append-only history), so readers accept both and the audit view explains the
 * old one; nothing writes them any more.
 */
export const PRE_RENAME_KAIJU_NAMES = {
  kobe_mcp_mode: "kaiju_mcp_mode",
  kobe_reads_per_minute: "kaiju_reads_per_minute",
  kobe_writes_per_hour: "kaiju_writes_per_hour",
  kobe_admin_write: "kaiju_admin_write",
  kobe_admin_not_allowed: "kaiju_admin_not_allowed",
  kobe_admin_rate_limited: "kaiju_admin_rate_limited",
} as const;

/** The page shown in place of a Kaiju admin tool's output to a viewer without its permission (KA6). */
export const KAIJU_ADMIN_RESULT_HIDDEN = "Admin result hidden";

/** Longest server-built summary line of a Kaiju admin change (names resolved, KOBE-623). */
export const KAIJU_ADMIN_SUMMARY_MAX = 1_000;

/**
 * What an approval card shows for a Kaiju admin write (KOBE-623, spec kobe-admin-mcp §6 "The card"):
 * the scope (`Team Research`, or `Whole site`) and a summary line the server built from the input
 * (names resolved from ids), never from model text. The card still shows the exact input below
 * it; such an approval is never remembered and never part of "Approve all waiting".
 */
export const kaijuAdminApprovalSchema = z.strictObject({
  scope: z.enum(["team", "site"]),
  scope_label: z.string().min(1).max(200),
  summary: z.string().min(1).max(KAIJU_ADMIN_SUMMARY_MAX),
});
export type KaijuAdminApproval = z.infer<typeof kaijuAdminApprovalSchema>;
